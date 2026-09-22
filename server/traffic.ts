import { getDb } from './db.ts';
import { traffic_stats, settings } from './schema.ts';
import { eq, sql } from 'drizzle-orm';
import { log } from './logger.ts';

export interface BufferedTraffic {
  date: string;
  playlistId: string;
  playlistName: string;
  streamType: string;
  bytes: number;
}

export interface TrafficTypeBreakdown {
  live: number;
  movie: number;
  series: number;
  other: number;
}

export interface PlaylistTrafficSummary {
  playlistId: string;
  playlistName: string;
  totalBytes: number;
  byType: TrafficTypeBreakdown;
}

export interface DailyTrafficPoint {
  date: string;
  totalBytes: number;
  byType: TrafficTypeBreakdown;
}

export interface TrafficStatsResult {
  range: {
    startDate: string;
    endDate: string;
  };
  summary: {
    todayBytes: number;
    monthBytes: number;
    allTimeBytes: number;
    monthlyQuotaBytes: number;
    monthPercent: number;
  };
  totalBytes: number;
  byType: TrafficTypeBreakdown;
  byPlaylist: PlaylistTrafficSummary[];
  daily: DailyTrafficPoint[];
}

const DEFAULT_MONTHLY_QUOTA_GB = 10240; // 10 TB (Oracle Cloud Always Free egress limit)
const BYTES_PER_GB = 1024 * 1024 * 1024;

const trafficBuffer = new Map<string, BufferedTraffic>();
let flushTimer: NodeJS.Timeout | null = null;

/**
 * Record outbound traffic transmitted to a client downstream connection.
 * Thread-safe / buffered in-memory and flushed periodically via flushTraffic().
 */
export function recordTraffic(
  playlistId?: string | null,
  playlistName?: string | null,
  streamType?: string | null,
  bytes: number = 0
): void {
  if (!bytes || bytes <= 0) return;

  const today = new Date().toISOString().slice(0, 10);
  const pId = playlistId && playlistId.trim() ? playlistId.trim() : 'unknown';
  const pName = playlistName && playlistName.trim() ? playlistName.trim() : (pId === 'unknown' ? 'Unknown Playlist' : pId);
  const rawType = (streamType || '').toLowerCase();
  const type = ['live', 'movie', 'series'].includes(rawType) ? rawType : (rawType === 'vod' ? 'movie' : 'other');

  const key = `${today}::${pId}::${type}`;
  const existing = trafficBuffer.get(key);
  if (existing) {
    existing.bytes += bytes;
    if (pName && pName !== 'Unknown Playlist') {
      existing.playlistName = pName;
    }
  } else {
    trafficBuffer.set(key, {
      date: today,
      playlistId: pId,
      playlistName: pName,
      streamType: type,
      bytes,
    });
  }
}

/**
 * Flush all in-memory buffered traffic into the SQLite database.
 */
export function flushTraffic(): void {
  if (trafficBuffer.size === 0) return;
  const entries = Array.from(trafficBuffer.values());
  trafficBuffer.clear();

  try {
    const db = getDb();
    const now = Date.now();
    const sqlite = (db as any).session?.client;

    if (sqlite && typeof sqlite.transaction === 'function') {
      const stmt = sqlite.prepare(`
        INSERT INTO traffic_stats (id, date, playlistId, playlistName, streamType, bytes, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(date, playlistId, streamType) DO UPDATE SET
          bytes = traffic_stats.bytes + excluded.bytes,
          playlistName = excluded.playlistName,
          updatedAt = excluded.updatedAt
      `);

      const insertMany = sqlite.transaction((items: BufferedTraffic[]) => {
        for (const item of items) {
          const id = `${item.date}_${item.playlistId}_${item.streamType}`;
          stmt.run(id, item.date, item.playlistId, item.playlistName, item.streamType, item.bytes, now);
        }
      });

      insertMany(entries);
    } else {
      // Fallback via Drizzle prepared queries
      for (const item of entries) {
        const id = `${item.date}_${item.playlistId}_${item.streamType}`;
        db.insert(traffic_stats)
          .values({
            id,
            date: item.date,
            playlistId: item.playlistId,
            playlistName: item.playlistName,
            streamType: item.streamType,
            bytes: item.bytes,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [traffic_stats.date, traffic_stats.playlistId, traffic_stats.streamType],
            set: {
              bytes: sql`traffic_stats.bytes + ${item.bytes}`,
              playlistName: item.playlistName,
              updatedAt: now,
            },
          })
          .run();
      }
    }
  } catch (err: any) {
    log(`[Traffic] Failed to flush traffic stats: ${err.message}`);
    // Re-buffer entries so data isn't lost on transient DB lock
    for (const item of entries) {
      const key = `${item.date}::${item.playlistId}::${item.streamType}`;
      const existing = trafficBuffer.get(key);
      if (existing) {
        existing.bytes += item.bytes;
      } else {
        trafficBuffer.set(key, item);
      }
    }
  }
}

/**
 * Start periodic traffic flusher (runs every 10 seconds).
 */
export function initTrafficFlusher(): void {
  if (flushTimer) clearInterval(flushTimer);
  flushTimer = setInterval(flushTraffic, 10_000);
  flushTimer.unref?.();

  const exitHandler = () => {
    try {
      flushTraffic();
    } catch {}
  };
  process.once('beforeExit', exitHandler);
  process.once('SIGINT', exitHandler);
  process.once('SIGTERM', exitHandler);
}

export function stopTrafficFlusher(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  flushTraffic();
}

/**
 * Retrieve configured monthly traffic quota in bytes from settings.
 */
export function getMonthlyTrafficQuotaBytes(): number {
  try {
    const db = getDb();
    const doc = db.select().from(settings).where(eq(settings.id, 'global')).get();
    const extra = (doc?.extra as any) || {};
    const quotaGB = typeof extra.monthlyTrafficQuotaGB === 'number' && extra.monthlyTrafficQuotaGB > 0
      ? extra.monthlyTrafficQuotaGB
      : DEFAULT_MONTHLY_QUOTA_GB;
    return quotaGB * BYTES_PER_GB;
  } catch {
    return DEFAULT_MONTHLY_QUOTA_GB * BYTES_PER_GB;
  }
}

/**
 * Get current month's consumed bytes and quota.
 */
export function getMonthTrafficBytes(): { monthBytes: number; quotaBytes: number } {
  flushTraffic();
  const db = getDb();
  const now = new Date();
  const monthStart = `${now.toISOString().slice(0, 7)}-01`;
  const today = now.toISOString().slice(0, 10);

  let monthBytes = 0;
  try {
    const sqlite = (db as any).session?.client;
    if (sqlite) {
      const row = sqlite.prepare(`
        SELECT SUM(bytes) as total FROM traffic_stats WHERE date >= ? AND date <= ?
      `).get(monthStart, today);
      monthBytes = Number(row?.total || 0);
    }
  } catch (err: any) {
    log(`[Traffic] Error reading month traffic: ${err.message}`);
  }

  const quotaBytes = getMonthlyTrafficQuotaBytes();
  return { monthBytes, quotaBytes };
}

/**
 * Fetch detailed traffic statistics for a date range (defaults to current month).
 */
export function getTrafficStats(customStartDate?: string, customEndDate?: string): TrafficStatsResult {
  flushTraffic();
  const db = getDb();
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const monthStart = `${now.toISOString().slice(0, 7)}-01`;

  const startDate = customStartDate && /^\d{4}-\d{2}-\d{2}$/.test(customStartDate)
    ? customStartDate
    : monthStart;
  const endDate = customEndDate && /^\d{4}-\d{2}-\d{2}$/.test(customEndDate)
    ? customEndDate
    : today;

  const sqlite = (db as any).session?.client;
  let rows: Array<{
    date: string;
    playlistId: string;
    playlistName: string;
    streamType: string;
    bytes: number;
  }> = [];

  let todayBytes = 0;
  let monthBytes = 0;
  let allTimeBytes = 0;

  if (sqlite) {
    try {
      rows = sqlite.prepare(`
        SELECT date, playlistId, playlistName, streamType, bytes
        FROM traffic_stats
        WHERE date >= ? AND date <= ?
        ORDER BY date ASC
      `).all(startDate, endDate) as any;

      const todayRow = sqlite.prepare(`
        SELECT SUM(bytes) as total FROM traffic_stats WHERE date = ?
      `).get(today);
      todayBytes = Number(todayRow?.total || 0);

      const monthRow = sqlite.prepare(`
        SELECT SUM(bytes) as total FROM traffic_stats WHERE date >= ? AND date <= ?
      `).get(monthStart, today);
      monthBytes = Number(monthRow?.total || 0);

      const allTimeRow = sqlite.prepare(`
        SELECT SUM(bytes) as total FROM traffic_stats
      `).get();
      allTimeBytes = Number(allTimeRow?.total || 0);
    } catch (err: any) {
      log(`[Traffic] Error querying traffic_stats: ${err.message}`);
    }
  }

  const monthlyQuotaBytes = getMonthlyTrafficQuotaBytes();
  const monthPercent = monthlyQuotaBytes > 0
    ? Math.round((monthBytes / monthlyQuotaBytes) * 10000) / 100
    : 0;

  let totalRangeBytes = 0;
  const byType: TrafficTypeBreakdown = { live: 0, movie: 0, series: 0, other: 0 };
  const playlistMap = new Map<string, { playlistId: string; playlistName: string; totalBytes: number; byType: TrafficTypeBreakdown }>();
  const dailyMap = new Map<string, { date: string; totalBytes: number; byType: TrafficTypeBreakdown }>();

  for (const r of rows) {
    const bytes = Number(r.bytes) || 0;
    const type = (['live', 'movie', 'series'].includes(r.streamType) ? r.streamType : 'other') as keyof TrafficTypeBreakdown;
    totalRangeBytes += bytes;
    byType[type] += bytes;

    // Aggregate by playlist
    const pEntry = playlistMap.get(r.playlistId) || {
      playlistId: r.playlistId,
      playlistName: r.playlistName || r.playlistId,
      totalBytes: 0,
      byType: { live: 0, movie: 0, series: 0, other: 0 },
    };
    pEntry.totalBytes += bytes;
    pEntry.byType[type] += bytes;
    if (r.playlistName && r.playlistName !== 'Unknown Playlist') {
      pEntry.playlistName = r.playlistName;
    }
    playlistMap.set(r.playlistId, pEntry);

    // Aggregate by day
    const dEntry = dailyMap.get(r.date) || {
      date: r.date,
      totalBytes: 0,
      byType: { live: 0, movie: 0, series: 0, other: 0 },
    };
    dEntry.totalBytes += bytes;
    dEntry.byType[type] += bytes;
    dailyMap.set(r.date, dEntry);
  }

  const byPlaylist = Array.from(playlistMap.values()).sort((a, b) => b.totalBytes - a.totalBytes);
  const daily = Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));

  return {
    range: {
      startDate,
      endDate,
    },
    summary: {
      todayBytes,
      monthBytes,
      allTimeBytes,
      monthlyQuotaBytes,
      monthPercent,
    },
    totalBytes: totalRangeBytes,
    byType,
    byPlaylist,
    daily,
  };
}

/**
 * Reset traffic statistics, optionally for a specific playlist.
 */
export function resetTrafficStats(playlistId?: string): void {
  trafficBuffer.clear();
  const db = getDb();
  const sqlite = (db as any).session?.client;
  if (!sqlite) return;

  if (playlistId) {
    sqlite.prepare(`DELETE FROM traffic_stats WHERE playlistId = ?`).run(playlistId);
  } else {
    sqlite.prepare(`DELETE FROM traffic_stats`).run();
  }
}
