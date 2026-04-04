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

export async function getSnapshot(sourceId: string, type: string): Promise<any> {
  const db = getDb();
  const doc = await db.collection('source_snapshots').findOne({ sourceId, type });
  return doc?.snapshot ?? null;
}

export async function setSnapshot(sourceId: string, type: string, snapshot: any): Promise<void> {
  const db = getDb();
  await db.collection('source_snapshots').updateOne(
    { sourceId, type },
    { $set: { snapshot, updatedAt: new Date().toISOString() } },
    { upsert: true }
  );
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
      await db.collection('source_changelogs').insertOne({
        sourceId,
        type,
        timestamp: new Date().toISOString(),
        added: added.slice(0, 500), // Cap payload size
        removed: removed.slice(0, 500),
        renamed: renamed.slice(0, 500),
        totalAdded: added.length,
        totalRemoved: removed.length,
        totalRenamed: renamed.length
      });

      // Cleanup: keep only last 500 logs per source
      const logs = await db.collection('source_changelogs')
        .find({ sourceId })
        .sort({ timestamp: -1 })
        .toArray();
      if (logs.length > 500) {
        const toDelete = logs.slice(500).map(l => l._id);
        await db.collection('source_changelogs').deleteMany({ _id: { $in: toDelete } });
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
    const lastSyncMeta = await db.collection('source_sync_meta').findOne({ key: metaKey });
    if (lastSyncMeta && new Date(lastSyncMeta.timestamp) > fiveMinsAgo) {
      return { success: true, skipped: true };
    }
  }

  const source = await db.collection('sources').findOne({ _id: toId(sourceId) });
  if (!source) return { error: "Source not found" };

  log(`[Sync] Starting ${type} sync for: ${source.name}`);
  const client = new XtreamClient(source as any);

  try {
    let upstreamStreams: any[] = [];
    if (type === 'live') upstreamStreams = await client.getLiveStreams();
    else if (type === 'vod') upstreamStreams = await client.getMovies();
    else if (type === 'series') upstreamStreams = await client.getSeries();

    log(`[Sync] Fetched ${upstreamStreams.length} ${type} streams from upstream`);

    const playlistIds = (await db.collection('playlists').find({ sourceIds: sourceId.toString() }).toArray()).map(p => p._id.toString());
    const mappings = await db.collection('mappings').find({
      playlistId: { $in: playlistIds },
      type
    }).toArray();

    const idKey = type === 'live' ? 'stream_id' : type === 'vod' ? 'stream_id' : 'series_id';
    const streamMap = new Map(upstreamStreams.map((s: any) => [s[idKey].toString(), s]));
    let updatedCount = 0;
    let totalExamined = mappings.length;

    const ops = mappings.map(m => {
      // originalId may be source-prefixed (e.g. "0_1234") — strip prefix for upstream lookup
      let lookupId = m.originalId;
      if (lookupId.includes('_')) {
        const parts = lookupId.split('_');
        if (!isNaN(parseInt(parts[0]))) lookupId = parts.slice(1).join('_');
      }
      const upstream = streamMap.get(lookupId) as any;
      if (!upstream) return null;

      const isUnmodified = !m.customName || m.customName === m.originalName;
      const updates: any = { originalName: upstream.name || upstream.title };

      if (isUnmodified && (upstream.name || upstream.title) !== m.originalName) {
        updates.customName = upstream.name || upstream.title;
        updatedCount++;
      }

      const hasChanges = Object.keys(updates).some(k => updates[k] !== (m as any)[k]);
      if (hasChanges) {
        return {
          updateOne: {
            filter: { _id: m._id },
            update: { $set: updates }
          }
        };
      }
      return null;
    }).filter(Boolean);

    if (ops.length > 0) {
      await db.collection('mappings').bulkWrite(ops as any);
    }

    const lastUpdated = new Date().toISOString();
    await db.collection('sources').updateOne({ _id: toId(sourceId) }, { $set: { lastUpdated } });
    await db.collection('source_sync_meta').updateOne(
      { key: metaKey },
      { $set: { timestamp: lastUpdated } },
      { upsert: true }
    );

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
  const sources = await db.collection('sources').find({ autoSyncEnabled: true, syncCron: { $exists: true } }).toArray();

  for (const source of sources) {
    scheduleSourceCron(source);
  }

  // Warm cold stream caches in the background so the first IPTV client request
  // is served from cache rather than blocking on an upstream fetch.
  (async () => {
    try {
      const allSources = await db.collection('sources').find({}).toArray();
      const warmTasks = allSources.flatMap(source => {
        const sid = source._id.toString();
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
