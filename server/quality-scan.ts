import { getDb } from "./db.ts";
import { XtreamClient } from "./xtream.ts";

export interface ScanJob {
  id: string;
  userId: string;
  status: 'running' | 'done' | 'cancelled';
  total: number;
  done: number;
  failed: number;
  results: { streamId: string; meta?: any; error?: string }[];
}

export const scanJobs = new Map<string, ScanJob>();

// Module-level cache for global quality format (invalidated on PATCH /api/settings)
let _qualityFormatCache: { value: string; expiresAt: number } | null = null;

export async function getGlobalQualityFormat(): Promise<string> {
  if (_qualityFormatCache && Date.now() < _qualityFormatCache.expiresAt) {
    return _qualityFormatCache.value;
  }
  const db = getDb();
  const doc = await db.collection('settings').findOne({ _id: 'global' as any });
  const value = (doc as any)?.qualityLabelFormat ?? '{surround::exists["[{surround}] "||""]}{hdr::exists["[{hdr}] "||""]}[{label}]';
  _qualityFormatCache = { value, expiresAt: Date.now() + 60_000 };
  return value;
}

/**
 * Invalidate the global quality format cache.
 */
export function invalidateQualityFormatCache() {
  _qualityFormatCache = null;
}

export function buildStreamUrl(sourceDoc: any, streamId: string, type: 'live' | 'vod' | 'series', extension?: string): string {
  const cl = new XtreamClient(sourceDoc as any);
  if (type === 'live') return cl.getLiveStreamUrl(streamId);
  if (type === 'vod') return cl.getVodStreamUrl(streamId, extension || 'mp4');
  return cl.getSeriesStreamUrl(streamId, extension || 'mp4');
}
