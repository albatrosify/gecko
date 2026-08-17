import { Router } from "express";
import { requireAuth, AuthRequest } from "../auth.ts";
import { getDb, generateId } from "../db.ts";
import { log } from "../logger.ts";
import { scheduleSourceCron, refreshSource, activeCrons } from "../sync.ts";
import { getCached, setCache } from "../cache.ts";
import { XtreamClient } from "../xtream.ts";
import { parseXtreamExpDate } from "../utils.ts";

export function createSourcesRouter() {
  const router = Router();

  // =====================================
  // CRUD: Sources
  // =====================================
  router.get("/sources", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const { sources: schemaSources } = await import('../schema.ts');
    const { eq } = await import('drizzle-orm');
    const docs = db.select().from(schemaSources).where(eq(schemaSources.userId, req.user!.id)).all();
    const formatted = docs.map(d => ({
      id: d.id, userId: d.userId, name: d.name, type: d.type, url: d.url,
      username: d.username, password: d.password, autoSyncEnabled: d.autoSyncEnabled, syncCron: d.syncCron,
      ...(d.extra as any || {})
    }));
    res.json(formatted);
  });

  router.post("/sources", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const { sources: schemaSources } = await import('../schema.ts');
    const newId = generateId();
    const { name, type, url, username, password, autoSyncEnabled, syncCron, expiryDate, ...extra } = req.body;

    extra.enabled = true;
    extra.lastUpdated = new Date().toISOString();
    if (expiryDate !== undefined) {
      extra.expiryDate = expiryDate;
    }

    if (type === 'xtream' && url && username && password) {
      try {
        const client = new XtreamClient({ url, username, password } as any);
        const auth = await client.authenticate();
        if (auth && auth.user_info) {
          extra.expiryDate = parseXtreamExpDate(auth.user_info.exp_date);
          if (auth.user_info.status) extra.accountStatus = auth.user_info.status;
          if (auth.user_info.max_connections !== undefined) extra.maxConnections = auth.user_info.max_connections;
        }
      } catch (e: any) {
        log(`[Sources] Failed to fetch account info for new source ${name}: ${e.message}`);
      }
    }

    db.insert(schemaSources).values({
      id: newId, userId: req.user!.id, name, type, url, username, password, autoSyncEnabled, syncCron, extra
    }).run();

    const newSource = { id: newId, userId: req.user!.id, name, type, url, username, password, autoSyncEnabled, syncCron, ...extra };
    scheduleSourceCron(newSource);
    res.status(201).json(newSource);
  });

  router.put("/sources/:id", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const { sources: schemaSources } = await import('../schema.ts');
    const { eq, and } = await import('drizzle-orm');
    const { id, name, type, url, username, password, autoSyncEnabled, syncCron, expiryDate, ...extra } = req.body;
    const sourceId = req.params.id;

    const doc = db.select().from(schemaSources).where(and(eq(schemaSources.id, sourceId), eq(schemaSources.userId, req.user!.id))).get();
    if (doc) {
      const mergedExtra = { ...(doc.extra as any || {}), ...extra };
      if (expiryDate !== undefined) {
        mergedExtra.expiryDate = expiryDate;
      }

      const targetType = type !== undefined ? type : doc.type;
      const targetUrl = url !== undefined ? url : doc.url;
      const targetUser = username !== undefined ? username : doc.username;
      const targetPass = password !== undefined ? password : doc.password;

      if (targetType === 'xtream' && targetUrl && targetUser && targetPass) {
        try {
          const client = new XtreamClient({ url: targetUrl, username: targetUser, password: targetPass } as any);
          const auth = await client.authenticate();
          if (auth && auth.user_info) {
            mergedExtra.expiryDate = parseXtreamExpDate(auth.user_info.exp_date);
            if (auth.user_info.status) mergedExtra.accountStatus = auth.user_info.status;
            if (auth.user_info.max_connections !== undefined) mergedExtra.maxConnections = auth.user_info.max_connections;
          }
        } catch (e: any) {
          log(`[Sources] Failed to fetch account info on update for ${sourceId}: ${e.message}`);
        }
      }

      db.update(schemaSources).set({
        name: name !== undefined ? name : doc.name,
        type: type !== undefined ? type : doc.type,
        url: url !== undefined ? url : doc.url,
        username: username !== undefined ? username : doc.username,
        password: password !== undefined ? password : doc.password,
        autoSyncEnabled: autoSyncEnabled !== undefined ? autoSyncEnabled : doc.autoSyncEnabled,
        syncCron: syncCron !== undefined ? syncCron : doc.syncCron,
        extra: mergedExtra
      }).where(eq(schemaSources.id, sourceId)).run();

      const fullSource = db.select().from(schemaSources).where(eq(schemaSources.id, sourceId)).get();
      if (fullSource) scheduleSourceCron({ ...fullSource, ...(fullSource.extra as any || {}) });
    }

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
      res.json({ success: false, error: (error as any).error });
    } else {
      const totalUpdated = results.reduce((acc, r: any) => acc + (r.updatedCount || 0), 0);
      res.json({ success: true, updatedCount: totalUpdated, results });
    }
  });

  router.get("/sources/:id/changelog", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const { source_changelogs: schemaChangelogs } = await import('../schema.ts');
    const { eq } = await import('drizzle-orm');

    const logs = db.select().from(schemaChangelogs).where(eq(schemaChangelogs.sourceId, req.params.id)).all();
    logs.sort((a, b) => {
      const tA = new Date((a.extra as any).timestamp || 0).getTime();
      const tB = new Date((b.extra as any).timestamp || 0).getTime();
      return tB - tA;
    });

    res.json(logs.slice(0, 20).map(l => ({ id: l.id, sourceId: l.sourceId, ...(l.extra as any || {}) })));
  });

  router.delete("/sources/:id", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const { sources: schemaSources } = await import('../schema.ts');
    const { eq, and } = await import('drizzle-orm');
    const sourceId = req.params.id;

    db.delete(schemaSources).where(and(eq(schemaSources.id, sourceId), eq(schemaSources.userId, req.user!.id))).run();

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
