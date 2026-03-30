import { Router } from "express";
import { requireAuth, AuthRequest } from "../auth.ts";
import { getDb, toId, docsWithId } from "../db.ts";
import { log } from "../logger.ts";
import { scheduleSourceCron, refreshSource, activeCrons } from "../sync.ts";
import { getCached, setCache } from "../cache.ts";
import { XtreamClient } from "../xtream.ts";

export function createSourcesRouter() {
  const router = Router();

  // =====================================
  // CRUD: Sources
  // =====================================
  router.get("/sources", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const docs = await db.collection('sources').find({ userId: req.user!.id }).toArray();
    res.json(docsWithId(docs));
  });

  router.post("/sources", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const source = {
      ...req.body,
      userId: req.user!.id,
      enabled: true,
      lastUpdated: new Date().toISOString(),
    };
    const result = await db.collection('sources').insertOne(source);
    const newSource = { id: result.insertedId.toString(), ...source };
    scheduleSourceCron(newSource);
    res.status(201).json(newSource);
  });

  router.put("/sources/:id", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const { id, ...update } = req.body;
    const sourceId = req.params.id;
    await db.collection('sources').updateOne(
      { _id: toId(sourceId), userId: req.user!.id },
      { $set: update }
    );

    const fullSource = await db.collection('sources').findOne({ _id: toId(sourceId) });
    if (fullSource) scheduleSourceCron(fullSource);

    res.json({ success: true });
  });

  router.post("/sources/:id/refresh", requireAuth, async (req: AuthRequest, res) => {
    const sid = req.params.id;
    log(`[Manual Sync] Starting manual total synchronization for source ID ${sid}`);

    const results = await Promise.all([
      refreshSource(sid, 'live', true),
      refreshSource(sid, 'vod', true),
      refreshSource(sid, 'series', true)
    ]);

    const error = results.find(r => (r as any).error);
    if (error) {
      res.status(500).json(error);
    } else {
      const totalUpdated = results.reduce((acc, r: any) => acc + (r.updatedCount || 0), 0);
      res.json({ success: true, updatedCount: totalUpdated, results });
    }
  });

  router.get("/sources/:id/changelog", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const logs = await db.collection('source_changelogs')
      .find({ sourceId: req.params.id })
      .sort({ timestamp: -1 })
      .limit(20)
      .toArray();
    res.json(logs);
  });

  router.delete("/sources/:id", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const sourceId = req.params.id;
    await db.collection('sources').deleteOne({ _id: toId(sourceId), userId: req.user!.id });

    if (activeCrons.has(sourceId)) {
      activeCrons.get(sourceId).stop();
      activeCrons.delete(sourceId);
    }
    res.json({ success: true });
  });

  // =====================================
  // Upstream data fetch (with disk cache)
  // =====================================
  router.post("/fetch-upstream", requireAuth, async (req, res) => {
    const { source, sourceIndex, forceRefresh } = req.body;
    if (!source?.id) return res.status(400).json({ error: "Missing source ID" });

    log(`Fetching categories for source ${source.name} (id: ${source.id}, sourceIndex: ${sourceIndex}, forceRefresh: ${forceRefresh})`);
    const cacheKey = `${source.id}_categories`;

    let data;
    const cached = !forceRefresh ? getCached(cacheKey) : null;
    if (cached) {
      log(`  Cache hit for categories: ${source.id}`);
      data = { ...cached.data, cached: true, lastUpdated: cached.lastUpdated };
    } else {
      log(`  Cache miss for categories: ${source.id}. Fetching from ${source.url}`);
      if (source.type === 'xtream') {
        const client = new XtreamClient(source);
        try {
          log(`  Requesting categories from Xtream API...`);
          const [liveCats, vodCats, seriesCats] = await Promise.all([
            client.getLiveCategories(),
            client.getVodCategories(),
            client.getSeriesCategories()
          ]);

          log(`  Successfully fetched: ${liveCats?.length || 0} live, ${vodCats?.length || 0} vod, ${seriesCats?.length || 0} series categories`);

          data = { liveCats, vodCats, seriesCats };
          setCache(cacheKey, data);
          data = { ...data, cached: false, lastUpdated: new Date().toISOString() };
        } catch (error: any) {
          log(`  ERROR fetching categories for ${source.id}: ${error.message}`);
          return res.status(500).json({ error: "Failed to fetch categories: " + error.message });
        }
      } else {
        return res.status(400).json({ error: `Source type '${source.type}' does not support category fetching` });
      }
    }

    // Deep clone cached data to avoid modifying global cache in-place
    const liveCats = data.liveCats ? JSON.parse(JSON.stringify(data.liveCats)) : null;
    const vodCats = data.vodCats ? JSON.parse(JSON.stringify(data.vodCats)) : null;
    const seriesCats = data.seriesCats ? JSON.parse(JSON.stringify(data.seriesCats)) : null;

    // Tag categories with source index for editor use — do NOT mutate category_id or id
    if (sourceIndex !== undefined && sourceIndex !== null) {
      const tag = (cats: any[]) => cats?.forEach((c: any) => { c._sourceIdx = sourceIndex; });
      tag(liveCats);
      tag(vodCats);
      tag(seriesCats);
    }

    res.json({ ...data, liveCats, vodCats, seriesCats });
  });

  router.post("/fetch-streams", requireAuth, async (req, res) => {
    const { source, type, sourceIndex, forceRefresh } = req.body;
    if (!source?.id || !type) return res.status(400).json({ error: "Missing source ID or type" });

    log(`Fetching streams [${type}] for source ${source.name} (id: ${source.id}, sourceIndex: ${sourceIndex}, forceRefresh: ${forceRefresh})`);
    const cacheKey = `${source.id}_streams_${type}`;

    let data;
    const cached = !forceRefresh ? getCached(cacheKey) : null;
    if (cached) {
      log(`  Cache hit for streams [${type}]: ${source.id}`);
      data = { streams: cached.data, cached: true, lastUpdated: cached.lastUpdated };
    } else {
      log(`  Cache miss for streams [${type}]: ${source.id}. Fetching from ${source.url}`);
      const client = new XtreamClient(source);
      try {
        let streams;
        log(`  Requesting streams [${type}] from Xtream API...`);
        if (type === 'live') streams = await client.getLiveStreams();
        else if (type === 'vod') streams = await client.getMovies();
        else if (type === 'series') streams = await client.getSeries();

        log(`  Successfully fetched ${streams?.length || 0} streams`);
        setCache(cacheKey, streams);
        data = { streams, cached: false, lastUpdated: new Date().toISOString() };
      } catch (error: any) {
        log(`  ERROR fetching streams [${type}] for ${source.id}: ${error.message}`);
        return res.status(500).json({ error: "Failed to fetch streams: " + error.message });
      }
    }

    // Deep clone cached data to avoid modifying global cache in-place
    const streams = data.streams ? JSON.parse(JSON.stringify(data.streams)) : null;

    // Tag streams with their source index for UI deduplication — do NOT mutate stream_id or category_id
    if (sourceIndex !== undefined && sourceIndex !== null) {
      if (streams) {
        streams.forEach((s: any) => {
          s._sourceIdx = sourceIndex;
        });
      }
    }

    res.json({ ...data, streams });
  });

  return router;
}
