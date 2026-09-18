import { Router } from "express";
import { requireAuth, AuthRequest } from "../auth.ts";
import { getDb, generateId } from "../db.ts";
import { log } from "../logger.ts";
import { scheduleSourceCron, refreshSource, activeCrons } from "../sync.ts";
import { getCached, setCache } from "../cache.ts";
import { XtreamClient } from "../xtream.ts";
import { parseXtreamExpDate, isValidHttpUrl } from "../utils.ts";
import { checkSourceConnection, getConnectionLogs, clearConnectionLogs } from "../connection-monitor.ts";
import { normalizeHosts, benchmarkSourceHosts, getHostBenchmarkHistory } from "../hosts.ts";
import { isConcurrencyGuardEnabled } from "../multiplexer/stream-guard.ts";

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
      ...(d.extra as any || {}),
      id: d.id, userId: d.userId, name: d.name, type: d.type, url: d.url,
      username: d.username, password: d.password, autoSyncEnabled: d.autoSyncEnabled, syncCron: d.syncCron,
    }));
    res.json(formatted);
  });

  router.post("/sources", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const { sources: schemaSources } = await import('../schema.ts');
    const newId = generateId();
    const { name, type, url, username, password, autoSyncEnabled, syncCron, expiryDate, hosts, ...extra } = req.body;

    delete (extra as any).id;
    delete (extra as any).userId;

    extra.enabled = true;
    extra.lastUpdated = new Date().toISOString();
    if (expiryDate !== undefined) {
      extra.expiryDate = expiryDate;
    }

    let primaryUrl = url;
    if (type === 'xtream') {
      if (hosts !== undefined) {
        primaryUrl = url || (Array.isArray(hosts) && hosts[0]?.url) || (Array.isArray(hosts) && hosts[0]) || '';
        const normalized = normalizeHosts(Array.isArray(hosts) ? hosts : [], primaryUrl);
        for (const h of normalized) {
          if (!isValidHttpUrl(h.url)) {
            return res.status(400).json({ error: `Invalid host URL: ${h.url}. Must start with http:// or https://` });
          }
        }
        extra.hosts = normalized;
      }
    }

    if (!primaryUrl || !isValidHttpUrl(primaryUrl)) {
      return res.status(400).json({ error: "Invalid URL. Must start with http:// or https://" });
    }

    if (type === 'xtream' && primaryUrl && username && password) {
      try {
        const client = new XtreamClient({ url: primaryUrl, username, password } as any);
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

    if (extra.concurrencyGuard === undefined) {
      extra.concurrencyGuard = isConcurrencyGuardEnabled(extra);
    }

    db.insert(schemaSources).values({
      id: newId, userId: req.user!.id, name, type, url: primaryUrl, username, password, autoSyncEnabled, syncCron, extra
    }).run();

    const newSource = { ...(extra || {}), id: newId, userId: req.user!.id, name, type, url: primaryUrl, username, password, autoSyncEnabled, syncCron };
    scheduleSourceCron(newSource);
    res.status(201).json(newSource);
  });

  router.put("/sources/:id", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const { sources: schemaSources } = await import('../schema.ts');
    const { eq, and } = await import('drizzle-orm');
    const { id, name, type, url, username, password, autoSyncEnabled, syncCron, expiryDate, hosts, ...extra } = req.body;
    const sourceId = req.params.id;

    delete (extra as any).id;
    delete (extra as any).userId;

    const doc = db.select().from(schemaSources).where(and(eq(schemaSources.id, sourceId), eq(schemaSources.userId, req.user!.id))).get();
    if (!doc) {
      return res.status(404).json({ error: "Source not found" });
    }

    const mergedExtra = { ...(doc.extra as any || {}), ...extra };
    if (expiryDate !== undefined) {
      mergedExtra.expiryDate = expiryDate;
    }

    const targetType = type !== undefined ? type : doc.type;
    const targetUrl = url !== undefined ? url : doc.url;
    const targetUser = username !== undefined ? username : doc.username;
    const targetPass = password !== undefined ? password : doc.password;

    if (url !== undefined && !isValidHttpUrl(targetUrl)) {
      return res.status(400).json({ error: "Invalid URL. Must start with http:// or https://" });
    }

    if (targetType === 'xtream' && hosts !== undefined) {
      const existingHosts = Array.isArray((doc.extra as any)?.hosts) ? (doc.extra as any).hosts : [];
      const normalized = normalizeHosts(Array.isArray(hosts) ? hosts : [], targetUrl, existingHosts);
      for (const h of normalized) {
        if (!isValidHttpUrl(h.url)) {
          return res.status(400).json({ error: `Invalid host URL: ${h.url}. Must start with http:// or https://` });
        }
      }
      mergedExtra.hosts = normalized;
    }

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
    }).where(
      req.user?.role === 'admin'
        ? eq(schemaSources.id, sourceId)
        : and(eq(schemaSources.id, sourceId), eq(schemaSources.userId, req.user!.id))
    ).run();

    const fullSource = db.select().from(schemaSources).where(
      req.user?.role === 'admin'
        ? eq(schemaSources.id, sourceId)
        : and(eq(schemaSources.id, sourceId), eq(schemaSources.userId, req.user!.id))
    ).get();
    if (fullSource) scheduleSourceCron({ ...(fullSource.extra as any || {}), ...fullSource });

    res.json({ success: true });
  });


  router.post("/sources/:id/refresh", requireAuth, async (req: AuthRequest, res) => {
    const sid = req.params.id;
    const db = getDb();
    const { sources: schemaSources } = await import('../schema.ts');
    const { eq, and } = await import('drizzle-orm');

    const source = db.select().from(schemaSources)
      .where(and(eq(schemaSources.id, sid), eq(schemaSources.userId, req.user!.id)))
      .get();
    if (!source) {
      return res.status(404).json({ error: "Source not found" });
    }

    log(`[Manual Sync] Starting manual total synchronization for source ID ${sid}`);

    const results = await Promise.all([
      refreshSource(sid, 'live', true),
      refreshSource(sid, 'vod', true),
      refreshSource(sid, 'series', true)
    ]);

    const errors = results.filter(r => (r as any).error).map(r => `[${(r as any).type || 'sync'}] ${(r as any).error}`);
    const warnings = results.map(r => (r as any).warning).filter(Boolean);
    const totalUpdated = results.reduce((acc, r: any) => acc + (r.updatedCount || 0), 0);

    const liveRes = results[0] as any;
    const vodRes = results[1] as any;
    const seriesRes = results[2] as any;

    const summary = {
      live: liveRes.error ? `Failed: ${liveRes.error}` : `${liveRes.fetchedCount ?? 0} streams`,
      vod: vodRes.error ? `Failed: ${vodRes.error}` : `${vodRes.fetchedCount ?? 0} movies`,
      series: seriesRes.error ? `Failed: ${seriesRes.error}` : `${seriesRes.fetchedCount ?? 0} series`,
    };

    if (errors.length === results.length) {
      // All types failed
      res.json({
        success: false,
        error: errors.join(' | '),
        summary,
        results
      });
    } else if (errors.length > 0) {
      // Partial failure (e.g. live succeeded, VOD timed out)
      res.json({
        success: true,
        partial: true,
        updatedCount: totalUpdated,
        warning: `Partial sync: ${errors.join(', ')}`,
        summary,
        results
      });
    } else {
      // All succeeded
      res.json({
        success: true,
        updatedCount: totalUpdated,
        warning: warnings.length > 0 ? warnings.join(' | ') : undefined,
        summary,
        results
      });
    }
  });

  router.get("/sources/:id/changelog", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const { sources: schemaSources, source_changelogs: schemaChangelogs } = await import('../schema.ts');
    const { eq, and } = await import('drizzle-orm');

    const source = db.select().from(schemaSources)
      .where(and(eq(schemaSources.id, req.params.id), eq(schemaSources.userId, req.user!.id)))
      .get();
    if (!source) {
      return res.status(404).json({ error: "Source not found" });
    }

    const logs = db.select().from(schemaChangelogs).where(eq(schemaChangelogs.sourceId, req.params.id)).all();
    logs.sort((a, b) => {
      const tA = new Date((a.extra as any).timestamp || 0).getTime();
      const tB = new Date((b.extra as any).timestamp || 0).getTime();
      return tB - tA;
    });

    res.json(logs.slice(0, 20).map(l => ({ id: l.id, sourceId: l.sourceId, ...(l.extra as any || {}) })));
  });

  // =====================================
  // Upstream Connection Monitor Endpoints
  // =====================================
  router.get("/sources/:id/connections", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const { sources: schemaSources } = await import('../schema.ts');
    const { eq, and } = await import('drizzle-orm');

    const source = db.select().from(schemaSources)
      .where(and(eq(schemaSources.id, req.params.id), eq(schemaSources.userId, req.user!.id)))
      .get();
    if (!source) {
      return res.status(404).json({ error: "Source not found" });
    }

    const limit = parseInt(req.query.limit as string || '100', 10);
    const logs = getConnectionLogs(req.params.id, isNaN(limit) ? 100 : limit);
    res.json(logs);
  });

  router.post("/sources/:id/connections/check", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const { sources: schemaSources } = await import('../schema.ts');
    const { eq, and } = await import('drizzle-orm');
    const sourceId = req.params.id;

    const doc = db.select().from(schemaSources).where(and(eq(schemaSources.id, sourceId), eq(schemaSources.userId, req.user!.id))).get();
    if (!doc) {
      return res.status(404).json({ error: "Source not found" });
    }

    const source = {
      id: doc.id,
      name: doc.name,
      type: doc.type as any,
      url: doc.url,
      username: doc.username || undefined,
      password: doc.password || undefined,
      ...(doc.extra as any || {})
    };

    try {
      const result = await checkSourceConnection(source, true);
      res.json({ success: true, log: result });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.delete("/sources/:id/connections", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const { sources: schemaSources } = await import('../schema.ts');
    const { eq, and } = await import('drizzle-orm');

    const source = db.select().from(schemaSources)
      .where(and(eq(schemaSources.id, req.params.id), eq(schemaSources.userId, req.user!.id)))
      .get();
    if (!source) {
      return res.status(404).json({ error: "Source not found" });
    }

    clearConnectionLogs(req.params.id);
    res.json({ success: true });
  });

  // =====================================
  // Host Benchmarking
  // =====================================
  router.post("/sources/:id/benchmark", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const { sources: schemaSources } = await import('../schema.ts');
    const { eq, and } = await import('drizzle-orm');

    const source = db.select().from(schemaSources)
      .where(and(eq(schemaSources.id, req.params.id), eq(schemaSources.userId, req.user!.id)))
      .get();
    if (!source) {
      return res.status(404).json({ error: "Source not found" });
    }

    try {
      const result = await benchmarkSourceHosts(req.params.id);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.get("/sources/:id/host-benchmarks", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const { sources: schemaSources } = await import('../schema.ts');
    const { eq, and } = await import('drizzle-orm');

    const source = db.select().from(schemaSources)
      .where(and(eq(schemaSources.id, req.params.id), eq(schemaSources.userId, req.user!.id)))
      .get();
    if (!source) {
      return res.status(404).json({ error: "Source not found" });
    }

    const limit = parseInt(req.query.limit as string || '50', 10);
    res.json(getHostBenchmarkHistory(req.params.id, isNaN(limit) ? 50 : limit));
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
    clearConnectionLogs(sourceId);
    res.json({ success: true });
  });

  // =====================================
  // Upstream data fetch (with disk cache)
  // =====================================
  router.post("/fetch-upstream", requireAuth, async (req: AuthRequest, res) => {
    const { source, sourceIndex, forceRefresh } = req.body;
    if (!source?.id) return res.status(400).json({ error: "Missing source ID" });

    const db = getDb();
    const { sources: schemaSources } = await import('../schema.ts');
    const { eq, and } = await import('drizzle-orm');

    const verifiedSourceDoc = db.select().from(schemaSources)
      .where(req.user?.role === 'admin'
        ? eq(schemaSources.id, source.id)
        : and(eq(schemaSources.id, source.id), eq(schemaSources.userId, req.user!.id)))
      .get();
    if (!verifiedSourceDoc) return res.status(404).json({ error: "Source not found" });

    const verifiedSource = {
      ...(verifiedSourceDoc.extra as any || {}),
      id: verifiedSourceDoc.id,
      userId: verifiedSourceDoc.userId,
      name: verifiedSourceDoc.name,
      type: verifiedSourceDoc.type,
      url: verifiedSourceDoc.url,
      username: verifiedSourceDoc.username,
      password: verifiedSourceDoc.password,
    };

    log(`Fetching categories for source ${verifiedSource.name} (id: ${verifiedSource.id}, sourceIndex: ${sourceIndex}, forceRefresh: ${forceRefresh})`);
    const cacheKey = `${verifiedSource.id}_categories`;

    let data;
    const cached = !forceRefresh ? getCached(cacheKey) : null;
    if (cached) {
      log(`  Cache hit for categories: ${verifiedSource.id}`);
      data = { ...cached.data, cached: true, lastUpdated: cached.lastUpdated };
    } else {
      log(`  Cache miss for categories: ${verifiedSource.id}. Fetching from ${verifiedSource.url}`);
      if (verifiedSource.type === 'xtream') {
        const client = new XtreamClient(verifiedSource as any);
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
          log(`  ERROR fetching categories for ${verifiedSource.id}: ${error.message}`);
          return res.status(500).json({ error: "Failed to fetch categories: " + error.message });
        }
      } else {
        return res.status(400).json({ error: `Source type '${verifiedSource.type}' does not support category fetching` });
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

  router.post("/fetch-streams", requireAuth, async (req: AuthRequest, res) => {
    const { source, type, sourceIndex, forceRefresh } = req.body;
    if (!source?.id || !type) return res.status(400).json({ error: "Missing source ID or type" });

    const db = getDb();
    const { sources: schemaSources } = await import('../schema.ts');
    const { eq, and } = await import('drizzle-orm');

    const verifiedSourceDoc = db.select().from(schemaSources)
      .where(req.user?.role === 'admin'
        ? eq(schemaSources.id, source.id)
        : and(eq(schemaSources.id, source.id), eq(schemaSources.userId, req.user!.id)))
      .get();
    if (!verifiedSourceDoc) return res.status(404).json({ error: "Source not found" });

    const verifiedSource = {
      ...(verifiedSourceDoc.extra as any || {}),
      id: verifiedSourceDoc.id,
      userId: verifiedSourceDoc.userId,
      name: verifiedSourceDoc.name,
      type: verifiedSourceDoc.type,
      url: verifiedSourceDoc.url,
      username: verifiedSourceDoc.username,
      password: verifiedSourceDoc.password,
    };

    log(`Fetching streams [${type}] for source ${verifiedSource.name} (id: ${verifiedSource.id}, sourceIndex: ${sourceIndex}, forceRefresh: ${forceRefresh})`);
    const cacheKey = `${verifiedSource.id}_streams_${type}`;

    let data;
    const cached = !forceRefresh ? getCached(cacheKey) : null;
    if (cached) {
      log(`  Cache hit for streams [${type}]: ${verifiedSource.id}`);
      data = { streams: cached.data, cached: true, lastUpdated: cached.lastUpdated };
    } else {
      log(`  Cache miss for streams [${type}]: ${verifiedSource.id}. Fetching from ${verifiedSource.url}`);
      const client = new XtreamClient(verifiedSource as any);
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
        log(`  ERROR fetching streams [${type}] for ${verifiedSource.id}: ${error.message}`);
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
