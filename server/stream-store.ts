import { getSqlite } from './db.ts';

/**
 * Normalised upstream catalog store (ADR 0002).
 *
 * The catalog is a *derived*, read-mostly snapshot of the upstream providers:
 * it is replaced wholesale per `(sourceId, type)` on every sync and never
 * joined transactionally. It used to live in `cache` as a ~22 MB JSON blob that
 * had to be parsed into JS objects on every request; it now lives in the
 * `streams` table with an FTS5 index over stream names.
 *
 * Provider-specific fields without a dedicated column are preserved in `extra`,
 * so a row round-trips back into an upstream-shaped object
 * (`toUpstreamStream`).
 */

export type StreamType = 'live' | 'vod' | 'series';

/** Upstream field names that map onto a dedicated column instead of `extra`. */
const PROMOTED_KEYS = new Set([
  'stream_id',
  'series_id',
  'name',
  'title',
  'category_id',
  'stream_icon',
  'cover',
  'epg_channel_id',
  'container_extension',
]);

/**
 * The trigram tokenizer needs at least 3 characters to use its index. Shorter
 * queries fall back to a scan of `streams`, which is still far cheaper than
 * parsing the old JSON blob.
 */
export const MIN_FTS_QUERY_LENGTH = 3;

export interface StreamRow {
  sourceId: string;
  type: StreamType;
  streamId: string;
  name: string | null;
  categoryId: string | null;
  icon: string | null;
  epgChannelId: string | null;
  containerExtension: string | null;
  extra: Record<string, unknown> | null;
}

export interface StreamSearchHit {
  sourceId: string;
  type: StreamType;
  streamId: string;
  name: string | null;
  categoryId: string | null;
}

/** Coerces a value to a non-empty string, or null. */
function asStringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const str = String(value);
  return str.length > 0 ? str : null;
}

/**
 * Maps a raw upstream stream object onto the `streams` shape.
 *
 * Returns null when the item carries no usable id — those cannot be stored and
 * are skipped by the caller.
 */
export function normalizeStream(sourceId: string, type: StreamType, item: unknown): StreamRow | null {
  const raw = (item ?? {}) as Record<string, unknown>;
  const streamId = asStringOrNull(raw.stream_id ?? raw.series_id);
  if (!streamId) return null;

  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!PROMOTED_KEYS.has(key)) extra[key] = value;
  }

  return {
    sourceId,
    type,
    streamId,
    // `name` is promoted from `name ?? title`; every consumer reads
    // `s.name || s.title`, so collapsing the two is lossless (verified).
    name: asStringOrNull(raw.name ?? raw.title),
    categoryId: asStringOrNull(raw.category_id),
    icon: asStringOrNull(raw.stream_icon ?? raw.cover),
    epgChannelId: asStringOrNull(raw.epg_channel_id),
    containerExtension: asStringOrNull(raw.container_extension),
    extra: Object.keys(extra).length > 0 ? extra : null,
  };
}

/** Rebuilds an upstream-shaped object from a stored row (inverse of normalize). */
export function toUpstreamStream(row: StreamRow): Record<string, unknown> {
  const base: Record<string, unknown> = { ...(row.extra ?? {}) };
  if (row.type === 'series') base.series_id = row.streamId;
  else base.stream_id = row.streamId;
  if (row.name !== null) base.name = row.name;
  if (row.categoryId !== null) base.category_id = row.categoryId;
  if (row.icon !== null) base.stream_icon = row.icon;
  if (row.epgChannelId !== null) base.epg_channel_id = row.epgChannelId;
  if (row.containerExtension !== null) base.container_extension = row.containerExtension;
  return base;
}

/**
 * Replaces the whole catalog partition for `(sourceId, type)` in a single
 * transaction: delete, bulk insert, then one full-text index rebuild.
 *
 * `INSERT OR REPLACE` keeps upstream duplicates from aborting a sync. The FTS
 * index is rebuilt once at the end rather than maintained per row — triggers
 * measured 2.25 s for 51 k rows versus 0.49 s for load + rebuild.
 *
 * @returns the number of rows stored.
 */
export function replaceSourceStreams(sourceId: string, type: StreamType, items: unknown[]): number {
  const sqlite = getSqlite();
  const updatedAt = Date.now();

  const rows: StreamRow[] = [];
  for (const item of items) {
    const row = normalizeStream(sourceId, type, item);
    if (row) rows.push(row);
  }

  const del = sqlite.prepare('DELETE FROM streams WHERE sourceId = ? AND type = ?');
  const ins = sqlite.prepare(`
    INSERT OR REPLACE INTO streams
      (sourceId, type, streamId, name, categoryId, icon, epgChannelId, containerExtension, extra, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const rebuild = sqlite.prepare("INSERT INTO streams_fts(streams_fts) VALUES('rebuild')");

  const write = sqlite.transaction((batch: StreamRow[]) => {
    del.run(sourceId, type);
    for (const row of batch) {
      ins.run(
        row.sourceId,
        row.type,
        row.streamId,
        row.name,
        row.categoryId,
        row.icon,
        row.epgChannelId,
        row.containerExtension,
        row.extra ? JSON.stringify(row.extra) : null,
        updatedAt,
      );
    }
    rebuild.run();
  });
  write(rows);

  return rows.length;
}

/** Escapes LIKE wildcards so user input is matched literally (used with `ESCAPE '\'`). */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Builds an FTS5 phrase query from user input.
 *
 * Because the trigram tokenizer indexes overlapping 3-character sequences, a
 * quoted phrase performs substring matching. Quoting also neutralises FTS5
 * operators (`OR`, `*`, `^`), so the term is matched literally.
 */
export function toMatchQuery(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

/** Rebuilds the whole FTS index from the `streams` content table. */
function rebuildStreamIndex(): void {
  getSqlite().prepare("INSERT INTO streams_fts(streams_fts) VALUES('rebuild')").run();
}

/**
 * Substring search over stream names.
 *
 * Queries of `MIN_FTS_QUERY_LENGTH` characters or more are served from the FTS5
 * trigram index via MATCH (measured ~0.2 ms on a 51 k catalog). Shorter queries
 * cannot be indexed by a trigram tokenizer and fall back to a scan of `streams`
 * (~10 ms) — still an order of magnitude cheaper than parsing the old JSON blob.
 */
export function searchStreams(
  query: string,
  options: { sourceIds?: string[]; type?: StreamType; limit?: number } = {},
): StreamSearchHit[] {
  const term = query.trim();
  if (term.length === 0) return [];

  const sqlite = getSqlite();
  const limit = options.limit ?? 50;

  const filters: string[] = [];
  const params: unknown[] = [];
  if (options.sourceIds && options.sourceIds.length > 0) {
    filters.push(`s.sourceId IN (${options.sourceIds.map(() => '?').join(', ')})`);
    params.push(...options.sourceIds);
  }
  if (options.type) {
    filters.push('s.type = ?');
    params.push(options.type);
  }
  const filterClause = filters.length > 0 ? ` AND ${filters.join(' AND ')}` : '';

  const columns = 's.sourceId, s.type, s.streamId, s.name, s.categoryId';

  if (term.length >= MIN_FTS_QUERY_LENGTH) {
    return sqlite
      .prepare(
        `SELECT ${columns}
         FROM streams_fts f
         JOIN streams s ON s.rowid = f.rowid
         WHERE f.name MATCH ?${filterClause}
         LIMIT ?`,
      )
      .all(toMatchQuery(term), ...params, limit) as StreamSearchHit[];
  }

  return sqlite
    .prepare(
      `SELECT ${columns}
       FROM streams s
       WHERE s.name LIKE ? ESCAPE '\\'${filterClause}
       LIMIT ?`,
    )
    .all(`%${escapeLike(term)}%`, ...params, limit) as StreamSearchHit[];
}

/** Number of stored streams for a source, optionally limited to one type. */
export function countSourceStreams(sourceId: string, type?: StreamType): number {
  const sqlite = getSqlite();
  const row = type
    ? sqlite.prepare('SELECT COUNT(*) AS c FROM streams WHERE sourceId = ? AND type = ?').get(sourceId, type)
    : sqlite.prepare('SELECT COUNT(*) AS c FROM streams WHERE sourceId = ?').get(sourceId);
  return Number((row as { c?: number } | undefined)?.c ?? 0);
}

/**
 * Deletes a source's catalog, optionally limited to one type, and rebuilds the
 * full-text index. Returns rows removed.
 */
export function deleteSourceStreams(sourceId: string, type?: StreamType): number {
  const sqlite = getSqlite();
  const result = type
    ? sqlite.prepare('DELETE FROM streams WHERE sourceId = ? AND type = ?').run(sourceId, type)
    : sqlite.prepare('DELETE FROM streams WHERE sourceId = ?').run(sourceId);
  rebuildStreamIndex();
  return result.changes ?? 0;
}

/** Reads a single stored stream, or null. */
export function getStreamRow(sourceId: string, type: StreamType, streamId: string): StreamRow | null {
  const sqlite = getSqlite();
  const row = sqlite
    .prepare(
      `SELECT sourceId, type, streamId, name, categoryId, icon, epgChannelId, containerExtension, extra
       FROM streams WHERE sourceId = ? AND type = ? AND streamId = ?`,
    )
    .get(sourceId, type, streamId) as (Omit<StreamRow, 'extra'> & { extra: string | null }) | undefined;
  if (!row) return null;
  return { ...row, extra: row.extra ? (JSON.parse(row.extra) as Record<string, unknown>) : null };
}
