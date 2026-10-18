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

/** A single added/removed entry in a sync diff. */
export interface StreamChange {
  id: string;
  name: string | null;
}

/** A renamed entry in a sync diff. */
export interface StreamRename {
  id: string;
  oldName: string | null;
  newName: string | null;
}

export interface StreamDiff {
  added: StreamChange[];
  removed: StreamChange[];
  renamed: StreamRename[];
}

export interface ReplaceResult {
  /** Number of rows stored. */
  stored: number;
  /** Differences versus the previous contents of the partition. */
  changes: StreamDiff;
}

/**
 * Temp table holding the previous contents of the partition while it is being
 * replaced, so the diff can be computed in SQL instead of in JS. Temp tables are
 * per-connection, and this function is fully synchronous, so concurrent
 * callers (the startup cache warm-up uses `Promise.all`) cannot interleave.
 */
const PREV_TABLE = '_prev_streams';

const EMPTY_DIFF: StreamDiff = { added: [], removed: [], renamed: [] };

/**
 * Replaces the whole catalog partition for `(sourceId, type)` in a single
 * transaction and reports what changed.
 *
 * delete → bulk insert → one full-text index rebuild → SQL diff. `INSERT OR
 * REPLACE` keeps upstream duplicates from aborting a sync. The FTS index is
 * rebuilt once at the end rather than maintained per row — triggers measured
 * 2.25 s for 51 k rows versus 0.49 s for load + rebuild.
 *
 * The diff replaces the old JSON snapshot mechanism (ADR 0002): nothing has to
 * be serialised, stored or parsed to know what changed, and a first sync
 * legitimately reports no changes.
 */
export function replaceSourceStreamsWithDiff(
  sourceId: string,
  type: StreamType,
  items: unknown[],
): ReplaceResult {
  const sqlite = getSqlite();
  const updatedAt = Date.now();

  const rows: StreamRow[] = [];
  for (const item of items) {
    const row = normalizeStream(sourceId, type, item);
    if (row) rows.push(row);
  }

  sqlite.exec(`CREATE TEMP TABLE IF NOT EXISTS ${PREV_TABLE} (streamId TEXT PRIMARY KEY, name TEXT)`);

  const clearPrev = sqlite.prepare(`DELETE FROM ${PREV_TABLE}`);
  const fillPrev = sqlite.prepare(
    `INSERT OR REPLACE INTO ${PREV_TABLE}(streamId, name)
     SELECT streamId, name FROM streams WHERE sourceId = ? AND type = ?`,
  );
  const countPrev = sqlite.prepare(`SELECT COUNT(*) AS c FROM ${PREV_TABLE}`);
  const del = sqlite.prepare('DELETE FROM streams WHERE sourceId = ? AND type = ?');
  const ins = sqlite.prepare(`
    INSERT OR REPLACE INTO streams
      (sourceId, type, streamId, name, categoryId, icon, epgChannelId, containerExtension, extra, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const rebuild = sqlite.prepare("INSERT INTO streams_fts(streams_fts) VALUES('rebuild')");

  const selectAdded = sqlite.prepare(
    `SELECT streamId AS id, name FROM streams
     WHERE sourceId = ? AND type = ? AND streamId NOT IN (SELECT streamId FROM ${PREV_TABLE})`,
  );
  const selectRemoved = sqlite.prepare(
    `SELECT streamId AS id, name FROM ${PREV_TABLE}
     WHERE streamId NOT IN (SELECT streamId FROM streams WHERE sourceId = ? AND type = ?)`,
  );
  const selectRenamed = sqlite.prepare(
    `SELECT n.streamId AS id, o.name AS oldName, n.name AS newName
     FROM streams n JOIN ${PREV_TABLE} o ON o.streamId = n.streamId
     WHERE n.sourceId = ? AND n.type = ? AND IFNULL(n.name, '') <> IFNULL(o.name, '')`,
  );

  let changes: StreamDiff = EMPTY_DIFF;

  const write = sqlite.transaction((batch: StreamRow[]) => {
    clearPrev.run();
    fillPrev.run(sourceId, type);
    const hadPrevious = Number((countPrev.get() as { c: number }).c) > 0;

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

    // A first sync has no baseline, so "everything is new" is not a changelog.
    if (hadPrevious) {
      changes = {
        added: selectAdded.all(sourceId, type) as StreamChange[],
        removed: selectRemoved.all(sourceId, type) as StreamChange[],
        renamed: selectRenamed.all(sourceId, type) as StreamRename[],
      };
    }
  });
  write(rows);

  return { stored: rows.length, changes };
}

/**
 * Replaces the whole catalog partition for `(sourceId, type)`.
 *
 * @returns the number of rows stored.
 */
export function replaceSourceStreams(sourceId: string, type: StreamType, items: unknown[]): number {
  return replaceSourceStreamsWithDiff(sourceId, type, items).stored;
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

/**
 * Rebuilds the whole FTS index from the `streams` content table. Call this after
 * any write that bypasses `replaceSourceStreamsWithDiff` (e.g. a cascade delete).
 */
export function rebuildStreamSearchIndex(): void {
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
  rebuildStreamSearchIndex();
  invalidateSourceStreams(sourceId, type);
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

// ---------------------------------------------------------------------------
// Read access (replaces the JSON blob that used to live in `cache`)
// ---------------------------------------------------------------------------

/**
 * Short-lived in-process mirror, matching the TTL the old cache mirror used, so
 * repeated requests within the same minute do not re-materialise the catalog.
 * The `streams` table is the durable source of truth.
 */
const MIRROR_TTL_MS = 60_000;
const mirror = new Map<string, { data: unknown[]; expiresAt: number }>();

function mirrorKey(sourceId: string, type: StreamType): string {
  return `${sourceId}_${type}`;
}

/** Materialises a partition as upstream-shaped objects. */
function materializePartition(sourceId: string, type: StreamType): Record<string, unknown>[] {
  const rows = getSqlite()
    .prepare(
      `SELECT sourceId, type, streamId, name, categoryId, icon, epgChannelId, containerExtension, extra
       FROM streams WHERE sourceId = ? AND type = ?`,
    )
    .all(sourceId, type) as (Omit<StreamRow, 'extra'> & { extra: string | null })[];

  return rows.map((row) =>
    toUpstreamStream({
      ...row,
      extra: row.extra ? (JSON.parse(row.extra) as Record<string, unknown>) : null,
    }),
  );
}

/**
 * Returns a partition as upstream-shaped stream objects (the shape consumers had
 * before), served from a one-minute mirror and materialised from the table on a
 * miss. Returns an empty array when the partition has never been synced.
 */
export function readSourceStreams(sourceId: string, type: StreamType): any[] {
  const key = mirrorKey(sourceId, type);
  const hit = mirror.get(key);
  if (hit && Date.now() < hit.expiresAt && hit.data.length > 0) return hit.data as any[];

  const data = materializePartition(sourceId, type);
  if (data.length > 0) {
    mirror.set(key, { data, expiresAt: Date.now() + MIRROR_TTL_MS });
  }
  return data;
}

/**
 * Cache-shaped accessor (`{ data }` or null) so existing read sites keep their
 * `cached?.data ?? fetchFromUpstream()` structure while being backed by the
 * table instead of the removed JSON blob.
 */
export function getCachedStreams(sourceId: string, type: StreamType): { data: any[] } | null {
  const data = readSourceStreams(sourceId, type);
  return data.length > 0 ? { data } : null;
}

/**
 * Seeds the mirror with freshly synced data. Called by the sync instead of
 * writing the catalog back out as a JSON blob.
 */
export function primeSourceStreams(sourceId: string, type: StreamType, items: unknown[]): void {
  mirror.set(mirrorKey(sourceId, type), { data: items, expiresAt: Date.now() + MIRROR_TTL_MS });
}

/** Cheap presence check that never materialises the partition. */
export function hasSourceStreams(sourceId: string, type: StreamType): boolean {
  const hit = mirror.get(mirrorKey(sourceId, type));
  if (hit && Date.now() < hit.expiresAt) return hit.data.length > 0;

  const row = getSqlite()
    .prepare('SELECT 1 AS present FROM streams WHERE sourceId = ? AND type = ? LIMIT 1')
    .get(sourceId, type);
  return row !== undefined;
}

/**
 * Drops the in-memory mirror. Pass a source (and optionally a type) to scope it;
 * call with no arguments on a global cache clear.
 */
export function invalidateSourceStreams(sourceId?: string, type?: StreamType): void {
  if (!sourceId) {
    mirror.clear();
    return;
  }
  if (!type) {
    for (const key of Array.from(mirror.keys())) {
      if (key.startsWith(`${sourceId}_`)) mirror.delete(key);
    }
    return;
  }
  mirror.delete(mirrorKey(sourceId, type));
}
