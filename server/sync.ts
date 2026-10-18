import cron from "node-cron";
import cronstrue from "cronstrue";
import { getDb } from "./db.ts";
import { log } from "./logger.ts";
import { measureSync } from "./event-loop-monitor.ts";
import { XtreamClient } from "./xtream.ts";
import { setCache } from "./cache.ts";
import { parseXtreamExpDate, parseSourceStreamId } from "./utils.ts";
import {
  replaceSourceStreamsWithDiff,
  countSourceStreams,
  hasSourceStreams,
  primeSourceStreams,
} from "./stream-store.ts";

/** Number of items to process before yielding to the event loop so live streams are not starved. */
const SYNC_YIELD_BATCH_SIZE = 5_000;
const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

// Helper to compare data and generate a changelog without starving the event loop
async function getChangelog(oldItems: any[], newItems: any[], idField: string, nameField: string) {
  const added: any[] = [];
  const removed: any[] = [];
  const renamed: any[] = [];

  const oldMap = new Map();
  let count = 0;
  for (const item of (oldItems || [])) {
    oldMap.set(String(item[idField]), item);
    if (++count % SYNC_YIELD_BATCH_SIZE === 0) await yieldToEventLoop();
  }

  const seenIds = new Set();
  count = 0;
  for (const item of (newItems || [])) {
    const id = String(item[idField]);
    seenIds.add(id);
    const oldItem = oldMap.get(id);
    if (!oldItem) {
      added.push({ id, name: item[nameField] });
    } else if (oldItem[nameField] !== item[nameField]) {
      renamed.push({ id, oldName: oldItem[nameField], newName: item[nameField] });
    }
    if (++count % SYNC_YIELD_BATCH_SIZE === 0) await yieldToEventLoop();
  }

  count = 0;
  for (const item of (oldItems || [])) {
    const id = String(item[idField]);
    if (!seenIds.has(id)) {
      removed.push({ id, name: item[nameField] });
    }
    if (++count % SYNC_YIELD_BATCH_SIZE === 0) await yieldToEventLoop();
  }

  return { added, removed, renamed };
}

import { eq, and, inArray } from 'drizzle-orm';
import { sources, playlists, mappings, source_sync_meta, source_changelogs } from './schema.ts';
import { generateId } from './db.ts';
import { rememberStreamTitles } from './stream-title-cache.ts';

/**
 * Baseline snapshot key. Persisted in `source_sync_meta` (SQLite) rather than
 * the cache so the sync diff/changelog — and the keyword notifications built on
 * top of it — survive restarts and cache TTL.
 */
function snapshotKey(sourceId: string, type: string): string {
  return `snapshot_${sourceId}_${type}`;
}

export async function getSnapshot(sourceId: string, type: string): Promise<any> {
  const db = getDb();
  const row = db.select().from(source_sync_meta).where(eq(source_sync_meta.key, snapshotKey(sourceId, type))).get();
  return (row?.extra as any)?.snapshot ?? null;
}

export async function setSnapshot(sourceId: string, type: string, snapshot: any): Promise<void> {
  const db = getDb();
  const key = snapshotKey(sourceId, type);
  const now = new Date().toISOString();
  db.insert(source_sync_meta)
    .values({ key, lastSync: now, extra: { snapshot } })
    .onConflictDoUpdate({ target: source_sync_meta.key, set: { lastSync: now, extra: { snapshot } } })
    .run();
}

/**
 * Persists a computed changelog and trims the per-source history to the last
 * 500 entries. Non-throwing: a changelog failure must never break a sync.
 */
export function persistChangelog(
  sourceId: string,
  type: string,
  changes: { added: any[]; removed: any[]; renamed: any[] },
): void {
  try {
    const { added, removed, renamed } = changes;
    if (!added.length && !removed.length && !renamed.length) return;

    const db = getDb();
    log(`[Changelog] Recorded ${added.length} added, ${removed.length} removed, ${renamed.length} renamed for ${sourceId} (${type})`);
    db.insert(source_changelogs).values({
      id: generateId(),
      sourceId,
      extra: {
        type,
        timestamp: new Date().toISOString(),
        added: added.slice(0, 500), // Cap payload size
        removed: removed.slice(0, 500),
        renamed: renamed.slice(0, 500),
        totalAdded: added.length,
        totalRemoved: removed.length,
        totalRenamed: renamed.length
      }
    }).run();

    // Cleanup: keep only last 500 logs per source
    const logs = db.select({ id: source_changelogs.id, extra: source_changelogs.extra })
      .from(source_changelogs)
      .where(eq(source_changelogs.sourceId, sourceId))
      .all();

    logs.sort((a, b) => {
      const tA = new Date((a.extra as any).timestamp || 0).getTime();
      const tB = new Date((b.extra as any).timestamp || 0).getTime();
      return tB - tA; // sort desc
    });

    if (logs.length > 500) {
      const toDelete = logs.slice(500).map(l => l.id);
      db.delete(source_changelogs).where(inArray(source_changelogs.id, toDelete)).run();
    }
  } catch (err: any) {
    log(`[Changelog] FAILED to record: ${err.message}`);
  }
}

export async function recordSourceChanges(sourceId: string, type: string, oldData: any, newData: any): Promise<{ added: any[]; removed: any[]; renamed: any[] }> {
  let added: any[] = [];
  let removed: any[] = [];
  let renamed: any[] = [];

  try {
    if (type === 'categories') {
      const catTypes: ('live' | 'vod' | 'series')[] = ['live', 'vod', 'series'];
      for (const ct of catTypes) {
        const oldList = oldData?.[`${ct}Cats`] || [];
        const newList = newData?.[`${ct}Cats`] || [];
        const changes = await getChangelog(oldList, newList, 'category_id', 'category_name');
        added.push(...changes.added.map(c => ({ ...c, type: ct })));
        removed.push(...changes.removed.map(c => ({ ...c, type: ct })));
        renamed.push(...changes.renamed.map(c => ({ ...c, type: ct })));
      }
    } else {
      const idField = type === 'series' ? 'series_id' : 'stream_id';
      const changes = await getChangelog(oldData || [], newData || [], idField, 'name');
      added = changes.added;
      removed = changes.removed;
      renamed = changes.renamed;
    }
  } catch (err: any) {
    log(`[Changelog] FAILED to compute: ${err.message}`);
    return { added: [], removed: [], renamed: [] };
  }

  persistChangelog(sourceId, type, { added, removed, renamed });
  return { added, removed, renamed };
}

/** Escape user-controlled text for Telegram HTML parse mode. */
function escapeHtml(text: string): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const TYPE_LABELS: Record<string, string> = {
  live: 'Live TV',
  vod: 'VoD',
  series: 'Serien',
  categories: 'Kategorien',
};

/**
 * Sends a Telegram notification when a sync changelog contains newly-added or
 * renamed streams/categories matching the configured keywords. Intentionally
 * non-throwing so a Telegram hiccup never breaks the sync itself.
 */
async function notifyKeywordMatches(
  source: any,
  type: string,
  changes: { added: any[]; renamed: any[] }
): Promise<void> {
  try {
    const { getTelegramConfig, sendTelegramNotification } = await import('./telegram.ts');
    const config = await getTelegramConfig();
    const keywords = (config.telegramKeywords || []).map((k: string) => k.trim()).filter(Boolean);
    if (!config.enabled || keywords.length === 0) return;

    const matchesKeyword = (name: string | undefined): boolean => {
      if (!name) return false;
      const lower = name.toLowerCase();
      return keywords.some(k => lower.includes(k.toLowerCase()));
    };

    const matches: string[] = [];
    for (const c of changes.added || []) {
      if (matchesKeyword(c.name)) {
        const typeTag = c.type ? ` <i>(${escapeHtml(c.type)})</i>` : '';
        matches.push(`➕ <b>${escapeHtml(c.name)}</b>${typeTag} — neu hinzugefügt`);
      }
    }
    for (const c of changes.renamed || []) {
      if (matchesKeyword(c.newName)) {
        matches.push(`✏️ <b>${escapeHtml(c.oldName)}</b> → <b>${escapeHtml(c.newName)}</b> — umbenannt`);
      }
    }

    if (matches.length === 0) return;

    const typeLabel = TYPE_LABELS[type] || type;
    const overflow = matches.length > 20 ? matches.length - 20 : 0;
    const message =
      `🦎 <b>Gecko IPTV – Sync Treffer</b>\n\n` +
      `Quelle: <b>${escapeHtml(source.name || source.id)}</b>\n` +
      `Typ: ${typeLabel}\n` +
      `Zeit: <code>${new Date().toLocaleString()}</code>\n\n` +
      matches.slice(0, 20).join('\n') +
      (overflow > 0 ? `\n\n… und ${overflow} weitere` : '');

    await sendTelegramNotification(message, { parseMode: 'HTML' });
  } catch (err: any) {
    log(`[Telegram] Keyword notification failed: ${err.message}`);
  }
}

export async function refreshSource(sourceId: string, type: 'live' | 'vod' | 'series' = 'live', force: boolean = false) {
  const db = getDb();

  // Cooldown check: prevent refreshing the same source+type too often (e.g. within 5 mins)
  const metaKey = `${sourceId}_${type}`;
  const fiveMinsAgo = new Date(Date.now() - 5 * 60000);

  if (!force) {
    const lastSyncMeta = db.select().from(source_sync_meta).where(eq(source_sync_meta.key, metaKey)).get();
    // Only honour the cooldown when the cache is actually warm. `source_sync_meta`
    // survives a restart, but the cache may be cold (e.g. after a fresh DB or
    // expired cache) while the meta still looks "recently synced". Skipping here
    // would leave the cache cold and force every playlist load to hit the slow
    // upstream fetch. Fetch whenever the cache is cold.
    const cacheIsWarm = hasSourceStreams(sourceId, type);
    if (lastSyncMeta && lastSyncMeta.extra && new Date((lastSyncMeta.extra as any).timestamp) > fiveMinsAgo && cacheIsWarm) {
      return { success: true, skipped: true };
    }
  }

  const source = db.select().from(sources).where(eq(sources.id, sourceId)).get();
  if (!source) return { error: "Source not found", type };

  log(`[Sync] Starting ${type} sync for: ${source.name}`);
  const client = new XtreamClient(source as any);

  try {
    const sourceExtra = (source.extra as any) || {};

    // 1. Account authentication check upfront for Xtream sources (on force or live)
    if (source.type === 'xtream' && (type === 'live' || force)) {
      try {
        const auth = await client.authenticate();
        if (auth && typeof auth === 'object') {
          if (auth.user_info) {
            if (auth.user_info.auth === 0) {
              const reason = auth.user_info.message || 'Invalid username or password';
              log(`[Sync] Authentication rejected for ${source.name}: ${reason}`);
              return { error: `Authentication rejected: ${reason}`, type, isAuthError: true };
            }
            sourceExtra.expiryDate = parseXtreamExpDate(auth.user_info.exp_date);
            if (auth.user_info.status) sourceExtra.accountStatus = auth.user_info.status;
            if (auth.user_info.max_connections !== undefined) sourceExtra.maxConnections = auth.user_info.max_connections;
            if (auth.user_info.status && auth.user_info.status.toLowerCase() === 'expired') {
              log(`[Sync] Warning: Account for ${source.name} is marked EXPIRED`);
            }
          }
        }
      } catch (authErr: any) {
        log(`[Sync] Auth check error for ${source.name}: ${authErr.message}`);
        if (authErr.response?.status === 401 || authErr.response?.status === 403 || authErr.response?.status === 511) {
          return { error: `Authentication failed (HTTP ${authErr.response.status}): ${authErr.message}`, type, isAuthError: true };
        }
      }
    }

    // 2. Fetch streams from upstream
    let upstreamStreams: any = [];
    if (type === 'live') upstreamStreams = await client.getLiveStreams();
    else if (type === 'vod') upstreamStreams = await client.getVodStreams();
    else if (type === 'series') upstreamStreams = await client.getSeries();

    // 3. Validate upstreamStreams payload structure
    if (!Array.isArray(upstreamStreams)) {
      if (typeof upstreamStreams === 'string' && (upstreamStreams.includes('<html') || upstreamStreams.includes('<!DOCTYPE'))) {
        log(`[Sync] Error: Upstream returned HTML instead of ${type} streams for ${source.name}`);
        return { error: `Upstream returned HTML (server error, maintenance, or Cloudflare protection)`, type };
      }
      if (upstreamStreams && typeof upstreamStreams === 'object') {
        const obj = upstreamStreams as any;
        if (obj.user_info?.auth === 0) {
          return { error: `Authentication failed: ${obj.user_info?.message || 'Invalid credentials'}`, type, isAuthError: true };
        }
        if (obj.message || obj.error) {
          return { error: `Upstream error: ${obj.message || obj.error}`, type };
        }
      }
      return { error: `Invalid upstream response for ${type} (expected array, got ${typeof upstreamStreams})`, type };
    }

    // 4. Empty Streams Guard:
    // If source previously had streams stored, and upstream suddenly returns 0, do NOT wipe it!
    const prevCount = countSourceStreams(sourceId, type);
    if (upstreamStreams.length === 0 && prevCount > 0) {
      log(`[Sync] WARNING: Upstream returned 0 ${type} streams for ${source.name}, but previous cache had ${prevCount}. Preserving existing cache to prevent accidental wipeout.`);
      return {
        error: `Upstream returned 0 ${type} streams (previous cache had ${prevCount}). Cache preserved.`,
        type,
        fetchedCount: 0,
        preserved: true
      };
    }

    log(`[Sync] Fetched ${upstreamStreams.length} ${type} streams from upstream`);
    rememberStreamTitles(sourceId, type === 'vod' ? 'movie' : type as any, upstreamStreams);

    const allPlaylists = db.select({ id: playlists.id, sourceIds: playlists.sourceIds }).from(playlists).all();
    const playlistIds = allPlaylists
      .filter(p => {
        const sids = Array.isArray(p.sourceIds) ? p.sourceIds : [];
        return sids.includes(sourceId);
      })
      .map(p => p.id);

    const mList = playlistIds.length > 0
      ? db.select().from(mappings).where(and(inArray(mappings.playlistId, playlistIds), eq(mappings.type, type))).all()
      : [];

    const idKey = type === 'live' ? 'stream_id' : type === 'vod' ? 'stream_id' : 'series_id';
    const streamMap = new Map(upstreamStreams.map((s: any) => [String(s[idKey]), s]));
    let updatedCount = 0;
    let totalExamined = mList.length;

    db.transaction((tx) => {
      for (const m of mList) {
        const lookupId = parseSourceStreamId(m.originalId).id;
        const upstream = streamMap.get(lookupId) as any;
        if (!upstream) continue;

        const extra = (m.extra as any) || {};
        const isUnmodified = !extra.customName || extra.customName === extra.originalName;
        const updates: any = { ...extra, originalName: upstream.name || upstream.title };

        if (isUnmodified && (upstream.name || upstream.title) !== extra.originalName) {
          updates.customName = upstream.name || upstream.title;
          updatedCount++;
        }

        const hasChanges = Object.keys(updates).some(k => updates[k] !== extra[k]);
        if (hasChanges) {
          tx.update(mappings).set({ extra: updates }).where(eq(mappings.id, m.id)).run();
        }
      }
    });

    const lastUpdated = new Date().toISOString();
    sourceExtra.lastUpdated = lastUpdated;

    db.update(sources).set({ extra: sourceExtra }).where(eq(sources.id, sourceId)).run();

    db.insert(source_sync_meta)
      .values({ key: metaKey, lastSync: lastUpdated, extra: { timestamp: lastUpdated } })
      .onConflictDoUpdate({
        target: source_sync_meta.key,
        set: { lastSync: lastUpdated, extra: { timestamp: lastUpdated } }
      }).run();

    log(`[Sync] Completed for ${source.name} (${type}). Fetched ${upstreamStreams.length}, updated ${updatedCount} name(s).`);

    // Write the normalised catalog and derive the changelog from it (ADR 0002).
    // This replaces both the JSON blob write (`cache`) and the snapshot blob: the
    // diff is computed in SQL inside the same transaction, so nothing has to be
    // serialised, stored or parsed any more.
    await yieldToEventLoop();

    const { changes } = measureSync('sync:catalog-write', () =>
      replaceSourceStreamsWithDiff(sourceId, type, upstreamStreams));
    // Serve subsequent reads from the just-written partition.
    primeSourceStreams(sourceId, type, upstreamStreams);
    if (changes.added.length || changes.removed.length || changes.renamed.length) {
      persistChangelog(sourceId, type, changes);
      await notifyKeywordMatches(source, type, changes);
    }

    // Periodically (or on force) update categories too
    let categoryWarning: string | null = null;
    let categoriesCount = 0;
    if (force || type === 'live') {
      try {
        const catCacheKey = `${sourceId}_categories`;

        const [liveCats, vodCats, seriesCats] = await Promise.all([
          client.getLiveCategories(),
          client.getVodCategories(),
          client.getSeriesCategories()
        ]);

        const validLive = Array.isArray(liveCats) ? liveCats : [];
        const validVod = Array.isArray(vodCats) ? vodCats : [];
        const validSeries = Array.isArray(seriesCats) ? seriesCats : [];

        if (!Array.isArray(liveCats) && !Array.isArray(vodCats) && !Array.isArray(seriesCats)) {
          throw new Error('Upstream returned invalid category data (non-array)');
        }

        categoriesCount = validLive.length + validVod.length + validSeries.length;
        const newCats = { liveCats: validLive, vodCats: validVod, seriesCats: validSeries };
        const oldCatSnapshot = await getSnapshot(sourceId, 'categories');
        if (oldCatSnapshot) {
          const catChanges = await recordSourceChanges(sourceId, 'categories', oldCatSnapshot, newCats);
          await notifyKeywordMatches(source, 'categories', catChanges);
        }
        const newCatSnapshot = {
          liveCats: validLive.map((c: any) => ({ category_id: c.category_id, category_name: c.category_name })),
          vodCats: validVod.map((c: any) => ({ category_id: c.category_id, category_name: c.category_name })),
          seriesCats: validSeries.map((c: any) => ({ category_id: c.category_id, category_name: c.category_name }))
        };
        await setSnapshot(sourceId, 'categories', newCatSnapshot);
        setCache(catCacheKey, newCats);
      } catch (e: any) {
        log(`[Sync] Warning: Failed to update categories for source ${sourceId}: ${e?.message || e}`);
        categoryWarning = `Categories: ${e?.message || e}`;
      }
    }

    return {
      success: true,
      type,
      fetchedCount: upstreamStreams.length,
      categoriesCount: categoriesCount || undefined,
      updatedCount,
      totalExamined,
      lastUpdated,
      warning: categoryWarning || undefined
    };
  } catch (err: any) {
    log(`[Sync] Error for ${source.name} (${type}): ${err.message}`);
    return { error: err.message, type };
  }
}

export const activeCrons = new Map<string, any>();

export function scheduleSourceCron(source: any) {
  const sourceId = source._id?.toString() || source.id;
  if (!sourceId) return;

  if (activeCrons.has(sourceId)) {
    activeCrons.get(sourceId).stop();
    activeCrons.delete(sourceId);
  }

  if (!source.autoSyncEnabled || !source.syncCron) return;

  try {
    const job = cron.schedule(source.syncCron, async () => {
      log(`[Cron] Starting scheduled background sync for ${source.name}...`);
      try {
        await refreshSource(sourceId, 'live', false);
        await refreshSource(sourceId, 'vod', false);
        await refreshSource(sourceId, 'series', false);
        log(`[Cron] Background sync COMPLETED for ${source.name}.`);
      } catch (e: any) {
        log(`[Cron] Background sync FAILED for ${source.name}: ${e.message}`);
      }
    });
    activeCrons.set(sourceId, job);
    log(`[Cron] Scheduled sync for ${source.name}: "${cronstrue.toString(source.syncCron)}"`);
  } catch (err) {
    log(`[Cron] Failed to schedule for ${source.name} (Invalid cron expression: "${source.syncCron}")`);
  }
}

/**
 * Stops every scheduled job and rebuilds the schedule from the current sources.
 * Called on startup and whenever a source changes, so the schedule never has to
 * be patched per-source from another process.
 */
export async function rescheduleCrons(): Promise<void> {
  for (const job of activeCrons.values()) {
    try { job.stop(); } catch { /* already stopped */ }
  }
  activeCrons.clear();

  const allSources = getDb().select().from(sources).all();
  for (const source of allSources.filter(s => s.autoSyncEnabled && s.syncCron)) {
    scheduleSourceCron(source);
  }
}

export async function initCronManager() {
  log("Initializing Source Cron Manager...");
  const db = getDb();
  const allSources = db.select().from(sources).all();

  await rescheduleCrons();

  // Warm cold stream caches in the background so the first IPTV client request
  // is served from cache rather than blocking on an upstream fetch.
  (async () => {
    try {
      const warmTasks = allSources.flatMap(source => {
        const sid = source.id;
        return (['live', 'vod', 'series'] as const)
          .filter(type => !hasSourceStreams(sid, type))
          .map(type => {
            log(`[Startup] Warming cold cache: ${source.name} (${type})`);
            return refreshSource(sid, type, false).catch(() => {});
          });
      });
      await Promise.all(warmTasks);
    } catch (e: any) {
      log(`[Startup] Cache warm-up error: ${e.message}`);
    }
  })();
}
