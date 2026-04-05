import cron from "node-cron";
import cronstrue from "cronstrue";
import { getDb, toId } from "./db.ts";
import { log } from "./logger.ts";
import { XtreamClient } from "./xtream.ts";
import { getCached, setCache } from "./cache.ts";

// Helper to compare data and generate a changelog
export function getChangelog(oldItems: any[], newItems: any[], idField: string, nameField: string) {
  const added: any[] = [];
  const removed: any[] = [];
  const renamed: any[] = [];

  const oldMap = new Map();
  for (const item of (oldItems || [])) {
    oldMap.set(String(item[idField]), item);
  }

  const seenIds = new Set();
  for (const item of (newItems || [])) {
    const id = String(item[idField]);
    seenIds.add(id);
    const oldItem = oldMap.get(id);
    if (!oldItem) {
      added.push({ id, name: item[nameField] });
    } else if (oldItem[nameField] !== item[nameField]) {
      renamed.push({ id, oldName: oldItem[nameField], newName: item[nameField] });
    }
  }

  for (const item of (oldItems || [])) {
    const id = String(item[idField]);
    if (!seenIds.has(id)) {
      removed.push({ id, name: item[nameField] });
    }
  }

  return { added, removed, renamed };
}

import { eq, and, inArray } from 'drizzle-orm';
import { sources, playlists, mappings, source_sync_meta, source_changelogs } from './schema.ts';
import { generateId } from './db.ts';

export async function getSnapshot(sourceId: string, type: string): Promise<any> {
  const { getCached } = await import('./cache.ts');
  const cached = getCached(`snapshot_${sourceId}_${type}`);
  return cached?.data ?? null;
}

export async function setSnapshot(sourceId: string, type: string, snapshot: any): Promise<void> {
  const { setCache } = await import('./cache.ts');
  setCache(`snapshot_${sourceId}_${type}`, snapshot);
}

export async function recordSourceChanges(sourceId: string, type: string, oldData: any, newData: any) {
  try {
    const db = getDb();
    let added: any[] = [];
    let removed: any[] = [];
    let renamed: any[] = [];

    if (type === 'categories') {
      const catTypes: ('live' | 'vod' | 'series')[] = ['live', 'vod', 'series'];
      for (const ct of catTypes) {
        const oldList = oldData?.[`${ct}Cats`] || [];
        const newList = newData?.[`${ct}Cats`] || [];
        const changes = getChangelog(oldList, newList, 'category_id', 'category_name');
        added.push(...changes.added.map(c => ({ ...c, type: ct })));
        removed.push(...changes.removed.map(c => ({ ...c, type: ct })));
        renamed.push(...changes.renamed.map(c => ({ ...c, type: ct })));
      }
    } else {
      const idField = type === 'series' ? 'series_id' : 'stream_id';
      const nameField = type === 'series' ? 'name' : 'name'; // Xtream usually uses 'name' for all
      const changes = getChangelog(oldData || [], newData || [], idField, nameField);
      added = changes.added;
      removed = changes.removed;
      renamed = changes.renamed;
    }

    if (added.length || removed.length || renamed.length) {
      log(`[Changelog] Recorded ${added.length} added, ${removed.length} removed, ${renamed.length} renamed for ${sourceId} (${type})`);
      const newId = generateId();
      db.insert(source_changelogs).values({
        id: newId,
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
    }
  } catch (err: any) {
    log(`[Changelog] FAILED to record: ${err.message}`);
  }
}

export async function refreshSource(sourceId: string, type: 'live' | 'vod' | 'series' = 'live', force: boolean = false) {
  const db = getDb();

  // Cooldown check: prevent refreshing the same source+type too often (e.g. within 5 mins)
  const metaKey = `${sourceId}_${type}`;
  const fiveMinsAgo = new Date(Date.now() - 5 * 60000);

  if (!force) {
    const lastSyncMeta = db.select().from(source_sync_meta).where(eq(source_sync_meta.key, metaKey)).get();
    if (lastSyncMeta && lastSyncMeta.extra && new Date((lastSyncMeta.extra as any).timestamp) > fiveMinsAgo) {
      return { success: true, skipped: true };
    }
  }

  const source = db.select().from(sources).where(eq(sources.id, sourceId)).get();
  if (!source) return { error: "Source not found" };

  log(`[Sync] Starting ${type} sync for: ${source.name}`);
  const client = new XtreamClient(source as any);

  try {
    let upstreamStreams: any[] = [];
    if (type === 'live') upstreamStreams = await client.getLiveStreams();
    else if (type === 'vod') upstreamStreams = await client.getMovies();
    else if (type === 'series') upstreamStreams = await client.getSeries();

    log(`[Sync] Fetched ${upstreamStreams.length} ${type} streams from upstream`);

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
        let lookupId = m.originalId;
        if (lookupId.includes('_')) {
          const parts = lookupId.split('_');
          if (!isNaN(parseInt(parts[0]))) lookupId = parts.slice(1).join('_');
        }
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
    const sourceExtra = (source.extra as any) || {};
    sourceExtra.lastUpdated = lastUpdated;
    db.update(sources).set({ extra: sourceExtra }).where(eq(sources.id, sourceId)).run();

    db.insert(source_sync_meta)
      .values({ key: metaKey, lastSync: lastUpdated, extra: { timestamp: lastUpdated } })
      .onConflictDoUpdate({
        target: source_sync_meta.key,
        set: { lastSync: lastUpdated, extra: { timestamp: lastUpdated } }
      }).run();

    log(`[Sync] Completed for ${source.name} (${type}). Updated ${updatedCount} name(s).`);

    // Update disk cache for the UI
    const cacheKey = `${sourceId}_streams_${type}`;
    setCache(cacheKey, upstreamStreams);

    // Record changelog using MongoDB snapshot (TTL-independent)
    const idField = type === 'series' ? 'series_id' : 'stream_id';
    const oldSnapshot = await getSnapshot(sourceId, type);
    if (oldSnapshot) {
      recordSourceChanges(sourceId, type, oldSnapshot, upstreamStreams);
    }
    const newSnapshot = upstreamStreams.map((s: any) => ({ [idField]: s[idField], name: s.name || s.title }));
    await setSnapshot(sourceId, type, newSnapshot);

    // Periodically (or on force) update categories too
    if (force || type === 'live') {
      try {
        const catCacheKey = `${sourceId}_categories`;

        const [liveCats, vodCats, seriesCats] = await Promise.all([
          client.getLiveCategories(),
          client.getVodCategories(),
          client.getSeriesCategories()
        ]);

        const newCats = { liveCats, vodCats, seriesCats };
        const oldCatSnapshot = await getSnapshot(sourceId, 'categories');
        if (oldCatSnapshot) {
          recordSourceChanges(sourceId, 'categories', oldCatSnapshot, newCats);
        }
        const newCatSnapshot = {
          liveCats: liveCats.map((c: any) => ({ category_id: c.category_id, category_name: c.category_name })),
          vodCats: vodCats.map((c: any) => ({ category_id: c.category_id, category_name: c.category_name })),
          seriesCats: seriesCats.map((c: any) => ({ category_id: c.category_id, category_name: c.category_name }))
        };
        await setSnapshot(sourceId, 'categories', newCatSnapshot);
        setCache(catCacheKey, newCats);
      } catch (e) {}
    }

    return { success: true, updatedCount, totalExamined, lastUpdated };
  } catch (err: any) {
    log(`[Sync] Error for ${source.name} (${type}): ${err.message}`);
    return { error: err.message };
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

export async function initCronManager() {
  log("Initializing Source Cron Manager...");
  const db = getDb();
  const allSources = db.select().from(sources).all();
  const activeSources = allSources.filter(s => s.autoSyncEnabled && s.syncCron);

  for (const source of activeSources) {
    scheduleSourceCron(source);
  }

  // Warm cold stream caches in the background so the first IPTV client request
  // is served from cache rather than blocking on an upstream fetch.
  (async () => {
    try {
      const warmTasks = allSources.flatMap(source => {
        const sid = source.id;
        return (['live', 'vod', 'series'] as const)
          .filter(type => !getCached(`${sid}_streams_${type}`))
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
