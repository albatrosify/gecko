import { Router } from "express";
import axios from "axios";
import { requireAuth, requireAuthOrQuery, AuthRequest } from "../auth.ts";
import { getDb, generateId } from "../db.ts";
import { log } from "../logger.ts";
import { scheduleSourceCron, refreshSource } from "../sync.ts";
import { duplicateCache, getCached } from "../cache.ts";
import { XtreamClient } from "../xtream.ts";
import { buildStreamUrl } from "../quality-scan.ts";
import { getBaseUrl, proxySeriesInfoImages } from "../utils.ts";

export function createPlaylistsRouter(epgsRouter?: Router) {
  const router = Router();

  // =====================================
  // CRUD: Playlists
  // =====================================
  router.post("/playlists/:id/clone", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const playlistId = req.params.id;
    const { playlists: schemaPlaylists, sources: schemaSources, mappings: schemaMappings, categoryMappings: schemaCategoryMappings } = await import('../schema.ts');
    const { eq, and } = await import('drizzle-orm');
    const { name, username, password, sourceUsername, sourcePassword } = req.body;

    // Validate username uniqueness if overridden
    if (username) {
      const existing = db.select().from(schemaPlaylists).where(eq(schemaPlaylists.username, username)).get();
      if (existing) {
        return res.status(400).json({ error: "Playlist username already in use" });
      }
    }

    try {
      const sourcePlaylist = db.select().from(schemaPlaylists).where(and(eq(schemaPlaylists.id, playlistId), eq(schemaPlaylists.userId, req.user!.id))).get();
      if (!sourcePlaylist) return res.status(404).json({ error: "Source playlist not found" });

      let newSourceIds = (Array.isArray(sourcePlaylist.sourceIds) ? sourcePlaylist.sourceIds : []) as string[];
      log(`[Clone] Duplicating: ${sourcePlaylist.name} (${playlistId}). Original Source IDs: ${newSourceIds.join(', ')}`);

      // 0. Optionally create a new source if new credentials are provided
      if (sourceUsername && sourcePassword && newSourceIds.length > 0) {
        log(`[Clone] Creating new source override for: ${sourceUsername}`);
        const originalSourceId = newSourceIds[0];
        const originalSource = db.select().from(schemaSources).where(eq(schemaSources.id, originalSourceId)).get();

        if (originalSource) {
          const newSourceId = generateId();
          const extra = { ...(originalSource.extra as any || {}), enabled: true, lastUpdated: new Date().toISOString() };
          db.insert(schemaSources).values({
            id: newSourceId,
            userId: req.user!.id,
            name: `${originalSource.name} (${sourceUsername})`,
            type: originalSource.type,
            url: originalSource.url,
            username: sourceUsername,
            password: sourcePassword,
            autoSyncEnabled: originalSource.autoSyncEnabled,
            syncCron: originalSource.syncCron,
            extra
          }).run();

          newSourceIds = [newSourceId];
          log(`[Clone] Source cloned successfully: ${newSourceId}`);

          if (originalSource.autoSyncEnabled && originalSource.syncCron) {
            scheduleSourceCron({ id: newSourceId, name: `${originalSource.name} (${sourceUsername})`, autoSyncEnabled: originalSource.autoSyncEnabled, syncCron: originalSource.syncCron, ...extra });
          }

          const oldSid = originalSourceId;
          const newSid = newSourceId;
          duplicateCache(`${oldSid}_categories`, `${newSid}_categories`);
          duplicateCache(`${oldSid}_live_streams`, `${newSid}_live_streams`);
          duplicateCache(`${oldSid}_vod_streams`, `${newSid}_vod_streams`);
          duplicateCache(`${oldSid}_series`, `${newSid}_series`);

          refreshSource(newSourceId, 'live', true).catch(err => {
            log(`[Clone] Background refresh failed for new source ${newSourceId}: ${err?.message || err}`);
          });
        } else {
          log(`[Clone] WARNING: Original source ${originalSourceId} not found in DB.`);
        }
      }

      // 1. Create new playlist doc
      const newPlaylistId = generateId();
      const pExtra = { ...(sourcePlaylist.extra as any || {}), createdAt: new Date().toISOString() };
      db.insert(schemaPlaylists).values({
        id: newPlaylistId,
        userId: req.user!.id,
        name: name || `${sourcePlaylist.name} (Copy)`,
        username: username || sourcePlaylist.username,
        password: password || sourcePlaylist.password,
        sourceIds: newSourceIds,
        directStreams: sourcePlaylist.directStreams,
        extra: pExtra
      }).run();

      // 2. Clone Category Mappings
      const catMappings = db.select().from(schemaCategoryMappings).where(eq(schemaCategoryMappings.playlistId, playlistId)).all();
      if (catMappings.length > 0) {
        log(`[Clone] Found ${catMappings.length} category mappings to duplicate.`);
        db.transaction((tx) => {
          for (const m of catMappings) {
            tx.insert(schemaCategoryMappings).values({ id: generateId(), playlistId: newPlaylistId, type: m.type, originalId: m.originalId, extra: m.extra }).run();
          }
        });
      }

      // Helper to replace credentials in URLs
      const replaceUrlCredentials = (url: string, oldUser: string, oldPass: string, newUser: string, newPass: string) => {
        if (!url) return url;
        return url.split(`username=${oldUser}`).join(`username=${newUser}`)
                  .split(`password=${oldPass}`).join(`password=${newPass}`);
      };

      // 3. Clone Stream Mappings
      const streamMappings = db.select().from(schemaMappings).where(eq(schemaMappings.playlistId, playlistId)).all();
      if (streamMappings.length > 0) {
        log(`[Clone] Found ${streamMappings.length} stream mappings to duplicate.`);

        let oldUser = '', oldPass = '';
        if (sourceUsername && sourcePassword && newSourceIds.length > 0) {
          const originalSourceId = (Array.isArray(sourcePlaylist.sourceIds) ? sourcePlaylist.sourceIds : [])[0];
          if (originalSourceId) {
             const originalSource = db.select().from(schemaSources).where(eq(schemaSources.id, originalSourceId)).get();
             if (originalSource) {
               oldUser = originalSource.username || '';
               oldPass = originalSource.password || '';
             }
          }
        }

        db.transaction((tx) => {
          for (const m of streamMappings) {
            const extra = { ...(m.extra as any || {}) };
            if (sourceUsername && sourcePassword && oldUser && oldPass && extra.url) {
              extra.url = replaceUrlCredentials(extra.url, oldUser, oldPass, sourceUsername, sourcePassword);
            }
            tx.insert(schemaMappings).values({ id: generateId(), playlistId: newPlaylistId, type: m.type, originalId: m.originalId, extra }).run();
          }
        });
        log(`[Clone] Stream mappings duplicated successfully.`);
      }

      log(`[Clone] Success: Playlist duplicated to ${newPlaylistId}`);
      res.json({ id: newPlaylistId });
    } catch (err: any) {
      log(`Error cloning playlist ${playlistId}: ${err.message}`);
      res.status(500).json({ error: "Failed to clone playlist" });
    }
  });

  router.get("/playlists", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const { playlists: schemaPlaylists } = await import('../schema.ts');
    const { eq } = await import('drizzle-orm');

    const docs = db.select().from(schemaPlaylists).where(eq(schemaPlaylists.userId, req.user!.id)).all();
    const formatted = docs.map(d => ({
      id: d.id, userId: d.userId, name: d.name, username: d.username, password: d.password,
      sourceIds: d.sourceIds, directStreams: d.directStreams, ...(d.extra as any || {})
    }));
    res.json(formatted);
  });

  router.post("/playlists", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const { playlists: schemaPlaylists } = await import('../schema.ts');
    const { eq } = await import('drizzle-orm');
    const newId = generateId();

    if (req.body.username) {
      const existing = db.select().from(schemaPlaylists).where(eq(schemaPlaylists.username, req.body.username)).get();
      if (existing) {
        return res.status(400).json({ error: "Playlist username already in use" });
      }
    }

    const { name, username, password, sourceIds, directStreams, ...extra } = req.body;
    extra.enabled = true;
    extra.nextStreamId = 1;
    extra.isSynced = false;
    extra.epgIds = [];

    db.insert(schemaPlaylists).values({
      id: newId, userId: req.user!.id, name, username, password,
      sourceIds: sourceIds || [], directStreams, extra
    }).run();

    res.status(201).json({ id: newId, userId: req.user!.id, name, username, password, sourceIds: sourceIds || [], directStreams, ...extra });
  });

  router.put("/playlists/:id", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const { playlists: schemaPlaylists } = await import('../schema.ts');
    const { eq, and, ne } = await import('drizzle-orm');
    const { id, name, username, password, sourceIds, directStreams, ...extra } = req.body;

    const existing = db.select().from(schemaPlaylists).where(and(eq(schemaPlaylists.id, req.params.id), eq(schemaPlaylists.userId, req.user!.id))).get();
    if (!existing) return res.status(404).json({ error: "Playlist not found" });

    const currentExtra = (existing.extra as any) || {};
    if (!extra.nextStreamId) {
      extra.nextStreamId = currentExtra.nextStreamId ?? 1;
    }

    if (username && username !== existing.username) {
      const conflict = db.select().from(schemaPlaylists).where(eq(schemaPlaylists.username, username)).get();
      if (conflict) {
        return res.status(400).json({ error: "Playlist username already in use" });
      }
    }

    db.update(schemaPlaylists).set({
      name: name !== undefined ? name : existing.name,
      username: username !== undefined ? username : existing.username,
      password: password !== undefined ? password : existing.password,
      sourceIds: sourceIds !== undefined ? sourceIds : existing.sourceIds,
      directStreams: directStreams !== undefined ? directStreams : existing.directStreams,
      extra: { ...currentExtra, ...extra }
    }).where(eq(schemaPlaylists.id, req.params.id)).run();

    if (epgsRouter && (epgsRouter as any).invalidateEpgChannelCache) {
      (epgsRouter as any).invalidateEpgChannelCache(req.params.id);
    }
    res.json({ success: true });
  });

  // =====================================
  // Mark playlist as synced (keep upstream IDs)
  // =====================================
  router.post("/playlists/:id/sync", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const { playlists: schemaPlaylists, mappings: schemaMappings } = await import('../schema.ts');
    const { eq, and } = await import('drizzle-orm');
    const { id } = req.params;

    const doc = db.select().from(schemaPlaylists).where(and(eq(schemaPlaylists.id, id), eq(schemaPlaylists.userId, req.user!.id))).get();
    if (doc) {
      const extra = { ...(doc.extra as any || {}), isSynced: true };
      db.update(schemaPlaylists).set({ extra }).where(eq(schemaPlaylists.id, id)).run();
      db.delete(schemaMappings).where(eq(schemaMappings.playlistId, id)).run();
    }

    res.json({ success: true, message: "Playlist marked as synced. Re-import streams to apply." });
  });

  router.delete("/playlists/:id", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const { playlists: schemaPlaylists, mappings: schemaMappings, categoryMappings: schemaCategoryMappings } = await import('../schema.ts');
    const { eq, and } = await import('drizzle-orm');
    const playlistId = req.params.id;

    db.transaction((tx) => {
      tx.delete(schemaPlaylists).where(and(eq(schemaPlaylists.id, playlistId), eq(schemaPlaylists.userId, req.user!.id))).run();
      tx.delete(schemaMappings).where(eq(schemaMappings.playlistId, playlistId)).run();
      tx.delete(schemaCategoryMappings).where(eq(schemaCategoryMappings.playlistId, playlistId)).run();
    });

    res.json({ success: true });
  });

  // =====================================
  // Series info (seasons + episodes)
  // =====================================
  router.get("/playlists/:id/series-info", requireAuth, async (req: AuthRequest, res) => {
    const { seriesId } = req.query;
    if (!seriesId || typeof seriesId !== 'string') {
      return res.status(400).json({ error: 'seriesId required' });
    }
    try {
      const db = getDb();
      const { playlists: schemaPlaylists, sources: schemaSources } = await import('../schema.ts');
      const { eq, and, inArray } = await import('drizzle-orm');

      const playlistDoc = db.select().from(schemaPlaylists).where(and(eq(schemaPlaylists.id, req.params.id), eq(schemaPlaylists.userId, req.user!.id))).get();
      if (!playlistDoc) return res.status(404).json({ error: 'Playlist not found' });

      // Strip sourceIdx prefix (e.g. "0_12345" → sourceIdx=0, rawId="12345")
      let targetSIdx: number | null = null;
      let rawSeriesId = seriesId;
      if (seriesId.includes('_')) {
        const parts = seriesId.split('_');
        const possibleIdx = parseInt(parts[0]);
        if (!isNaN(possibleIdx)) {
          targetSIdx = possibleIdx;
          rawSeriesId = parts.slice(1).join('_');
        }
      }

      const imgBase = getBaseUrl(req);
      const sourceIds: string[] = (Array.isArray(playlistDoc.sourceIds) ? playlistDoc.sourceIds : []) as string[];

      const sourceDocs = sourceIds.length > 0
        ? db.select().from(schemaSources).where(inArray(schemaSources.id, sourceIds)).all()
        : [];

      const sourcesMap = new Map(sourceDocs.map(doc => [doc.id, doc]));

      for (let sourceIdx = 0; sourceIdx < sourceIds.length; sourceIdx++) {
        if (targetSIdx !== null && targetSIdx !== sourceIdx) continue;
        const sDoc = sourcesMap.get(sourceIds[sourceIdx]);
        if (!sDoc) continue;
        try {
          const client = new XtreamClient({ ...sDoc, ...(sDoc.extra as any || {}) } as any);
          const info = await client.getSeriesInfo(rawSeriesId);
          if (info && (info.seasons || info.episodes || info.info)) {
            return res.json(proxySeriesInfoImages(info, imgBase));
          }
        } catch { continue; }
      }
      res.status(404).json({ error: 'Series not found' });
    } catch (err: any) {
      log(`[series-info] error: ${err?.message || err}`);
      res.status(500).json({ error: 'Failed to fetch series info' });
    }
  });

  // =====================================
  // Global playlist search
  // =====================================
  router.get("/playlists/:id/search", requireAuth, async (req: AuthRequest, res) => {
    const { q } = req.query;
    if (!q || typeof q !== 'string' || q.trim().length < 2) {
      return res.status(400).json({ error: 'q must be at least 2 characters' });
    }

    try {
      const db = getDb();
      const { playlists: schemaPlaylists, sources: schemaSources } = await import('../schema.ts');
      const { eq, and, inArray } = await import('drizzle-orm');

      const playlistDoc = db.select().from(schemaPlaylists).where(and(eq(schemaPlaylists.id, req.params.id), eq(schemaPlaylists.userId, req.user!.id))).get();
      if (!playlistDoc) return res.status(404).json({ error: 'Playlist not found' });

      const sourceIds: string[] = (Array.isArray(playlistDoc.sourceIds) ? playlistDoc.sourceIds : []) as string[];
      const sourceDocs = sourceIds.length > 0
        ? db.select().from(schemaSources).where(inArray(schemaSources.id, sourceIds)).all()
        : [];
      const sourcesMap = new Map(sourceDocs.map(doc => [doc.id, doc]));
      const validSources = sourceIds.map(sid => sourcesMap.get(sid)).filter(Boolean);

      const qLower = q.trim().toLowerCase();
      const seen = new Set<string>();
      const results: any[] = [];

      outer:
      for (const sourceDoc of validSources) {
        const sourceId = sourceDoc.id;

        // Category name lookup — cache stores { liveCats, vodCats, seriesCats }
        const catCache = getCached(`${sourceId}_categories`);
        const catMap = new Map<string, string>();
        if (catCache?.data) {
          const { liveCats, vodCats, seriesCats } = catCache.data as any;
          for (const cat of [...(liveCats || []), ...(vodCats || []), ...(seriesCats || [])]) {
            catMap.set(String(cat.category_id), cat.category_name || '');
          }
        }

        for (const type of ['live', 'vod', 'series'] as const) {
          const cached = getCached(`${sourceId}_streams_${type}`);
          if (!cached?.data) continue; // skip types not yet loaded in this session

          for (const stream of cached.data as any[]) {
            const name: string = stream.name || stream.title || '';
            if (!name.toLowerCase().includes(qLower)) continue;

            const streamId = String(stream.stream_id ?? stream.series_id);
            const key = `${type}:${streamId}`;
            if (seen.has(key)) continue;
            seen.add(key);

            const categoryId = String(stream.category_id || '');
            results.push({
              streamId,
              name,
              type,
              categoryId,
              categoryName: catMap.get(categoryId) || '',
            });

            if (results.length >= 50) break outer;
          }
        }
      }

      res.json({ results });
    } catch (err: any) {
      log(`[search] error: ${err?.message || err}`);
      res.status(500).json({ error: 'Search failed' });
    }
  });

  // =====================================
  // VOD / Series download proxy
  // =====================================
  router.get("/download/:type/:playlistId/:streamId", requireAuthOrQuery, async (req: AuthRequest, res) => {
    const { type, playlistId, streamId } = req.params;
    if (!['vod', 'series'].includes(type)) {
      return res.status(400).json({ error: 'type must be vod or series' });
    }

    try {
      const db = getDb();
      const { playlists: schemaPlaylists, sources: schemaSources } = await import('../schema.ts');
      const { eq, and, inArray } = await import('drizzle-orm');

      const playlistDoc = db.select().from(schemaPlaylists).where(and(eq(schemaPlaylists.id, playlistId), eq(schemaPlaylists.userId, req.user!.id))).get();
      if (!playlistDoc) return res.status(404).json({ error: 'Playlist not found' });

      const sourceIds: string[] = (Array.isArray(playlistDoc.sourceIds) ? playlistDoc.sourceIds : []) as string[];
      const sourceDocs = sourceIds.length > 0
        ? db.select().from(schemaSources).where(inArray(schemaSources.id, sourceIds)).all()
        : [];
      const sourcesMap = new Map(sourceDocs.map(doc => [doc.id, doc]));
      const validSources = sourceIds.map(sid => sourcesMap.get(sid)).filter(Boolean);
      if (!validSources.length) return res.status(400).json({ error: 'No sources found' });

      // Use first available source; get container_extension from stream cache
      const sourceDoc = validSources[0]!;
      const cached = getCached(`${sourceDoc.id}_streams_${type}`);
      const streamData = (cached?.data as any[] | undefined)?.find(
        (s: any) => String(s.stream_id ?? s.series_id) === streamId
      );
      const extension = streamData?.container_extension || 'mp4';
      const title = streamData?.name || streamData?.title || streamId;

      const url = buildStreamUrl({ ...sourceDoc, ...(sourceDoc.extra as any || {}) }, streamId, type as 'vod' | 'series', extension);

      // Proxy the upstream response as a file download
      const upstreamRes = await axios.get(url, {
        responseType: 'stream',
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) IPTV-Proxy/1.0' },
        timeout: 10_000,
      });

      const filename = `${title.replace(/[^\w\s.-]/g, '_')}.${extension}`;
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Type', upstreamRes.headers['content-type'] || 'application/octet-stream');
      if (upstreamRes.headers['content-length']) {
        res.setHeader('Content-Length', upstreamRes.headers['content-length']);
      }
      (upstreamRes.data as NodeJS.ReadableStream).pipe(res);
    } catch (e: any) {
      if (!res.headersSent) res.status(502).json({ error: `Upstream error: ${e.message}` });
    }
  });

  return router;
}
