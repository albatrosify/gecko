import { getCached } from './cache.ts';

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
}

const titleMap = new Map<string, string>();
const MAX_ENTRIES = 100_000;

function trimCacheIfNeeded() {
  if (titleMap.size > MAX_ENTRIES) {
    const keysToDelete = Math.floor(MAX_ENTRIES * 0.2); // prune oldest 20%
    const it = titleMap.keys();
    for (let i = 0; i < keysToDelete; i++) {
      const next = it.next();
      if (next.done) break;
      titleMap.delete(next.value);
    }
  }
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
  }

  trimCacheIfNeeded();
}

/**
 * Ingests series information (including all seasons and episodes) into the fast memory cache.
 */
export function rememberSeriesInfo(sourceId: string, seriesInfo: any): void {
  if (!seriesInfo) return;

  const seriesName = (seriesInfo.info?.name || seriesInfo.info?.title || seriesInfo.name || seriesInfo.title)?.trim();
  const episodes = seriesInfo.episodes;
  if (!episodes) return;

  // Xtream format: { "1": [ { id, episode_num, title, ... } ], "2": [...] } or array
  const seasonKeys = typeof episodes === 'object' && !Array.isArray(episodes)
    ? Object.keys(episodes)
    : (Array.isArray(episodes) ? ['0'] : []);

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
    }
  }

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
  const cleanId = streamId.includes('_') ? streamId.split('_').slice(1).join('_') : streamId;

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
        const cached = getCached(`${sid}_streams_${cacheType}`);
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

  return null;
}

/**
 * Resets the in-memory cache (primarily used in tests).
 */
export function clearStreamTitleCache(): void {
  titleMap.clear();
}
