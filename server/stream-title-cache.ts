import { getCachedStreams } from './stream-store.ts';
import { getSqlite, isDbConnected } from './db.ts';
import { log } from './logger.ts';
import { decodeStreamId } from './utils.ts';

/**
 * In-memory title cache for upstream streams (Live, VOD/Movies, and Series Episodes).
 * Provides fast O(1) lookups without disk I/O or JSON parsing overhead.
 */
export interface StreamTitleItem {
  stream_id?: string | number;
  series_id?: string | number;
  id?: string | number;
  name?: string;
  title?: string;
  stream_icon?: string;
  cover?: string;
}

const titleMap = new Map<string, string>();
/** Icon/poster per stream, same keys as `titleMap` (dashboard thumbnails). */
const iconMap = new Map<string, string>();
const MAX_ENTRIES = 100_000;

function trimCacheIfNeeded() {
  if (titleMap.size > MAX_ENTRIES) {
    const keysToDelete = Math.floor(MAX_ENTRIES * 0.2); // prune oldest 20%
    const it = titleMap.keys();
    for (let i = 0; i < keysToDelete; i++) {
      const next = it.next();
      if (next.done) break;
      titleMap.delete(next.value);
      iconMap.delete(next.value);
    }
  }
}

function rememberIcon(keys: string[], icon: string | undefined | null): void {
  const clean = icon?.trim();
  if (!clean) return;
  for (const key of keys) iconMap.set(key, clean);
}

/**
 * Persists episode rows so a restarted process still knows what `1938143` is.
 * Best effort: the in-memory cache is authoritative for this process, and unit
 * tests run without a database at all.
 */
function persistEpisodeMeta(sourceId: string, rows: { id: string; title: string; icon: string | null }[]): void {
  if (rows.length === 0 || !isDbConnected()) return;
  try {
    const sqlite = getSqlite();
    const upsert = sqlite.prepare(
      `INSERT INTO episode_meta (sourceId, episodeId, title, icon, updatedAt)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(sourceId, episodeId) DO UPDATE SET
         title = excluded.title, icon = excluded.icon, updatedAt = excluded.updatedAt`
    );
    const now = new Date().toISOString();
    const writeAll = (sqlite as any).transaction(() => {
      for (const row of rows) upsert.run(sourceId, row.id, row.title, row.icon, now);
    });
    writeAll();
  } catch (err: any) {
    log(`[Titles] Could not persist ${rows.length} episode title(s) for ${sourceId}: ${err.message}`);
  }
}

/**
 * Looks an episode up in SQLite and warms the in-memory cache from it. Returns the
 * metadata (or null) so callers can serve both title and icon from one query.
 */
function lookupEpisodeMeta(sourceIds: string[], episodeId: string): { title: string; icon: string | null } | null {
  if (!isDbConnected()) return null;
  try {
    const sqlite = getSqlite();
    for (const sid of sourceIds) {
      const row = sqlite.prepare('SELECT title, icon FROM episode_meta WHERE sourceId = ? AND episodeId = ?')
        .get(sid, episodeId) as { title?: string; icon?: string | null } | null | undefined;
      if (!row?.title) continue;
      titleMap.set(`${sid}:series:${episodeId}`, row.title);
      titleMap.set(`series:${episodeId}`, row.title);
      if (row.icon) rememberIcon([`${sid}:series:${episodeId}`, `series:${episodeId}`], row.icon);
      return { title: row.title, icon: row.icon ?? null };
    }
  } catch {
    // No database (unit tests, very early startup): the in-memory cache is all we have.
  }
  return null;
}

/**
 * Formats a clean, readable title for a series episode.
 * Examples:
 * - "Breaking Bad S01E03 - Cat's in the Bag..."
 * - "Dark S01E01" (if title is redundant like "Episode 1")
 */
export function formatEpisodeTitle(seriesName: string | undefined, ep: any): string {
  const sNum = parseInt(String(ep.season ?? 1), 10);
  const epNum = parseInt(String(ep.episode_num ?? ep.episode ?? 1), 10);
  const sStr = isNaN(sNum) ? '01' : String(sNum).padStart(2, '0');
  const epStr = isNaN(epNum) ? '01' : String(epNum).padStart(2, '0');
  const code = `S${sStr}E${epStr}`;

  const cleanSeries = seriesName?.trim();
  const rawTitle = (ep.title || ep.name || '')?.trim();

  // If rawTitle is empty or redundant ("Episode 1", "S01E01", etc.)
  const isRedundantTitle = !rawTitle ||
    new RegExp(`^s?0*${sNum}\\s*e?0*${epNum}$`, 'i').test(rawTitle) ||
    new RegExp(`^episode\\s*0*${epNum}$`, 'i').test(rawTitle) ||
    rawTitle.toLowerCase() === code.toLowerCase();

  if (cleanSeries) {
    if (isRedundantTitle) {
      return `${cleanSeries} ${code}`;
    }
    return `${cleanSeries} ${code} - ${rawTitle}`;
  }

  return isRedundantTitle ? code : `${code} - ${rawTitle}`;
}

/**
 * Ingests a list of streams (live or movie/vod) from an upstream source into the fast memory cache.
 */
export function rememberStreamTitles(
  sourceId: string,
  type: 'live' | 'movie' | 'series',
  streams: StreamTitleItem[]
): void {
  if (!Array.isArray(streams) || streams.length === 0) return;

  for (const s of streams) {
    const rawId = s.stream_id ?? s.series_id ?? s.id;
    if (rawId === undefined || rawId === null) continue;
    const id = String(rawId);
    const name = (s.name || s.title)?.trim();
    if (!name) continue;

    titleMap.set(`${sourceId}:${type}:${id}`, name);
    titleMap.set(`${type}:${id}`, name);
    rememberIcon([`${sourceId}:${type}:${id}`, `${type}:${id}`], s.stream_icon || s.cover);
  }

  trimCacheIfNeeded();
}

/**
 * Ingests series information (including all seasons and episodes) into the fast memory cache.
 */
export function rememberSeriesInfo(sourceId: string, seriesInfo: any): void {
  if (!seriesInfo) return;

  const seriesName = (seriesInfo.info?.name || seriesInfo.info?.title || seriesInfo.name || seriesInfo.title)?.trim();
  const seriesCover = (seriesInfo.info?.cover || seriesInfo.info?.movie_image || '')?.trim();
  const episodes = seriesInfo.episodes;
  if (!episodes) return;

  // Xtream format: { "1": [ { id, episode_num, title, ... } ], "2": [...] } or array
  const seasonKeys = typeof episodes === 'object' && !Array.isArray(episodes)
    ? Object.keys(episodes)
    : (Array.isArray(episodes) ? ['0'] : []);

  const persist: { id: string; title: string; icon: string | null }[] = [];

  for (const sKey of seasonKeys) {
    const epList = Array.isArray(episodes) ? episodes : episodes[sKey];
    if (!Array.isArray(epList)) continue;

    for (const ep of epList) {
      const epId = ep.id ?? ep.stream_id;
      if (epId === undefined || epId === null) continue;
      const id = String(epId);
      const formattedTitle = formatEpisodeTitle(seriesName, ep);

      titleMap.set(`${sourceId}:series:${id}`, formattedTitle);
      titleMap.set(`series:${id}`, formattedTitle);

      // Episode still first, then the series poster: a card without any image is
      // the most common case for series, so the fallback matters.
      const episodeIcon = (ep.info?.movie_image || ep.info?.cover || ep.movie_image || seriesCover || '')?.trim();
      if (episodeIcon) rememberIcon([`${sourceId}:series:${id}`, `series:${id}`], episodeIcon);

      persist.push({ id, title: formattedTitle, icon: episodeIcon || null });
    }
  }

  persistEpisodeMeta(sourceId, persist);
  trimCacheIfNeeded();
}

/**
 * Attempts to retrieve a stream title for the given source(s), stream type, and stream ID.
 * Returns null if not found.
 */
export function getStreamTitle(
  sourceIds: string[],
  type: 'live' | 'movie' | 'series',
  streamId: string
): string | null {
  const cleanId = decodeStreamId(streamId);

  // 1. Direct O(1) in-memory lookup by sourceId
  for (const sid of sourceIds) {
    const hit = titleMap.get(`${sid}:${type}:${cleanId}`) || titleMap.get(`${sid}:${type}:${streamId}`);
    if (hit) return hit;
  }

  // 2. Generic O(1) in-memory lookup (if streamId is known without source prefix)
  const genericHit = titleMap.get(`${type}:${cleanId}`) || titleMap.get(`${type}:${streamId}`);
  if (genericHit) return genericHit;

  // 3. Fallback: Warm up cache from getCached for live/movie if not yet in memory
  if (type === 'live' || type === 'movie') {
    const cacheType = type === 'live' ? 'live' : 'vod';
    for (const sid of sourceIds) {
      try {
        const cached = getCachedStreams(sid, cacheType);
        if (cached?.data && Array.isArray(cached.data)) {
          rememberStreamTitles(sid, type, cached.data);
          const hit = titleMap.get(`${sid}:${type}:${cleanId}`) || titleMap.get(`${sid}:${type}:${streamId}`);
          if (hit) return hit;
        }
      } catch {
        // Cache miss or db not initialized
      }
    }
  }

  // 4. Series episodes only exist in get_series_info, which the *client* fetched
  // once - possibly before this process started. Read the persisted copy.
  if (type === 'series') {
    return lookupEpisodeMeta(sourceIds, cleanId)?.title ?? null;
  }

  return null;
}

/**
 * Icon/poster for a stream, for the dashboard's "Now Playing" cards.
 * Returns null when the provider does not carry one.
 */
export function getStreamIcon(
  sourceIds: string[],
  type: 'live' | 'movie' | 'series',
  streamId: string
): string | null {
  const cleanId = decodeStreamId(streamId);

  for (const sid of sourceIds) {
    const hit = iconMap.get(`${sid}:${type}:${cleanId}`) || iconMap.get(`${sid}:${type}:${streamId}`);
    if (hit) return hit;
  }
  const genericHit = iconMap.get(`${type}:${cleanId}`) || iconMap.get(`${type}:${streamId}`);
  if (genericHit) return genericHit;

  if (type === 'series') {
    const meta = lookupEpisodeMeta(sourceIds, cleanId);
    if (meta?.icon) return meta.icon;
  }

  return null;
}

/**
 * Resets the in-memory cache (primarily used in tests).
 */
export function clearStreamTitleCache(): void {
  titleMap.clear();
  iconMap.clear();
}
