import { Router } from "express";
import axios from "axios";
import { requireAuth, requireAuthOrQuery, AuthRequest } from "../auth.ts";
import { getDb, toId, docsWithId } from "../db.ts";
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
    const { name, username, password, sourceUsername, sourcePassword } = req.body;

    // Validate username uniqueness if overridden
    if (username) {
      const existing = await db.collection('playlists').findOne({ username });
      if (existing) {
        return res.status(400).json({ error: "Playlist username already in use" });
      }
    }

    try {
      const sourcePlaylist = await db.collection('playlists').findOne({ _id: toId(playlistId), userId: req.user!.id });
      if (!sourcePlaylist) return res.status(404).json({ error: "Source playlist not found" });

      let newSourceIds = [...sourcePlaylist.sourceIds];
      const originalPlaylistIdStr = playlistId.toString();
      log(`[Clone] Duplicating: ${sourcePlaylist.name} (${originalPlaylistIdStr}). Original Source IDs: ${newSourceIds.join(', ')}`);

      // 0. Optionally create a new source if new credentials are provided
      if (sourceUsername && sourcePassword && sourcePlaylist.sourceIds.length > 0) {
        log(`[Clone] Creating new source override for: ${sourceUsername}`);
        const originalSourceId = sourcePlaylist.sourceIds[0];
        const originalSource = await db.collection('sources').findOne({ _id: toId(originalSourceId) });

        if (originalSource) {
          const newSourceDoc = {
            ...originalSource,
            _id: undefined,
            userId: req.user!.id,
            name: `${originalSource.name} (${sourceUsername})`,
            username: sourceUsername,
            password: sourcePassword,
            createdAt: new Date().toISOString()
          };
          delete (newSourceDoc as any)._id;
          const sourceResult = await db.collection('sources').insertOne(newSourceDoc);
          newSourceIds = [sourceResult.insertedId.toString()];
          log(`[Clone] Source cloned successfully: ${newSourceIds[0]}`);

          // Re-schedule cron for the new source IF enabled
          const ns = newSourceDoc as any;
          if (ns.autoSyncEnabled && ns.syncCron) {
            scheduleSourceCron({ ...ns, _id: sourceResult.insertedId });
          }

          // INSTANTLY duplicate the disk cache from old source to new source
          // so the user sees everything immediately
          const oldSid = originalSourceId.toString();
          const newSid = sourceResult.insertedId.toString();
          duplicateCache(`${oldSid}_categories`, `${newSid}_categories`);
          duplicateCache(`${oldSid}_live_streams`, `${newSid}_live_streams`);
          duplicateCache(`${oldSid}_vod_streams`, `${newSid}_vod_streams`);
          duplicateCache(`${oldSid}_series`, `${newSid}_series`);

          // FORCE an immediate refresh of the new source so the new playlist isn't "empty"
          // We do this in the background to not block the clone response too long,
          // but we start it now.
          refreshSource(sourceResult.insertedId.toString(), 'live', true).catch(err => {
            log(`[Clone] Background refresh failed for new source ${sourceResult.insertedId}: ${err?.message || err}`);
          });
        } else {
          log(`[Clone] WARNING: Original source ${originalSourceId} not found in DB.`);
        }
      }

      // 1. Create new playlist doc
      const newPlaylistDoc = {
        ...sourcePlaylist,
        _id: undefined,
        userId: req.user!.id,
        name: name || `${sourcePlaylist.name} (Copy)`,
        username: username || sourcePlaylist.username,
        password: password || sourcePlaylist.password,
        sourceIds: newSourceIds,
        createdAt: new Date().toISOString()
      };
      delete (newPlaylistDoc as any)._id;

      const result = await db.collection('playlists').insertOne(newPlaylistDoc);
      const newPlaylistId = result.insertedId.toString();

      // Use a filter that catches both string and ObjectId to be safe
      const playlistFilter = { $or: [{ playlistId: originalPlaylistIdStr }, { playlistId: toId(originalPlaylistIdStr) }] };

      // 2. Clone Category Mappings
      const catMappings = await db.collection('categoryMappings').find(playlistFilter).toArray();
      if (catMappings.length > 0) {
        log(`[Clone] Found ${catMappings.length} category mappings to duplicate.`);
        const newCatMappings = catMappings.map(m => {
          const newM = { ...m, _id: undefined, playlistId: newPlaylistId };
          delete (newM as any)._id;
          return newM;
        });
        await db.collection('categoryMappings').insertMany(newCatMappings);
      } else {
        log(`[Clone] No category mappings found for source ${originalPlaylistIdStr}`);
      }

      // Helper to replace credentials in URLs
      const replaceUrlCredentials = (url: string, oldUser: string, oldPass: string, newUser: string, newPass: string) => {
        if (!url) return url;
        return url.split(`username=${oldUser}`).join(`username=${newUser}`)
                  .split(`password=${oldPass}`).join(`password=${newPass}`);
      };

      // 3. Clone Stream Mappings
      const streamMappings = await db.collection('mappings').find(playlistFilter).toArray();
      if (streamMappings.length > 0) {
        log(`[Clone] Found ${streamMappings.length} stream mappings to duplicate.`);

        let oldUser = '', oldPass = '';
        if (sourceUsername && sourcePassword) {
          const originalSourceId = sourcePlaylist.sourceIds[0];
          const originalSource = await db.collection('sources').findOne({ _id: toId(originalSourceId) });
          if (originalSource) {
            oldUser = originalSource.username;
            oldPass = originalSource.password;
          }
        }

        const BATCH_SIZE = 1000;
        for (let i = 0; i < streamMappings.length; i += BATCH_SIZE) {
          const batch = streamMappings.slice(i, i + BATCH_SIZE).map(m => {
            const newMapping: any = {
              ...m,
              _id: undefined,
              playlistId: newPlaylistId
            };
            delete newMapping._id;

            if (sourceUsername && sourcePassword && oldUser && oldPass && newMapping.url) {
              newMapping.url = replaceUrlCredentials(newMapping.url, oldUser, oldPass, sourceUsername, sourcePassword);
            }

            return newMapping;
          });
          await db.collection('mappings').insertMany(batch);
        }
        log(`[Clone] Stream mappings duplicated successfully.`);
      } else {
        log(`[Clone] No stream mappings found for source playlist ${originalPlaylistIdStr}`);
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
    const docs = await db.collection('playlists').find({ userId: req.user!.id }).toArray();
    res.json(docsWithId(docs));
  });

  router.post("/playlists", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();

    // Validate username uniqueness
    if (req.body.username) {
      const existing = await db.collection('playlists').findOne({ username: req.body.username });
      if (existing) {
        return res.status(400).json({ error: "Playlist username already in use" });
      }
    }

    const playlist = {
      ...req.body,
      userId: req.user!.id,
      enabled: true,
      sourceIds: [],
      epgIds: [],
      nextStreamId: 1,
      isSynced: false, // Set to true if this is a synced upstream playlist
    };
    const result = await db.collection('playlists').insertOne(playlist);
    res.status(201).json({ id: result.insertedId.toString(), ...playlist });
  });

  router.put("/playlists/:id", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const { id, ...update } = req.body;

    // Preserve nextStreamId if not explicitly updating
    if (!update.nextStreamId) {
      const existing = await db.collection('playlists').findOne({
        _id: toId(req.params.id),
        userId: req.user!.id
      });
      if (existing) {
        update.nextStreamId = existing.nextStreamId ?? 1;
      }
    }

    // Validate username uniqueness if changing
    if (update.username) {
      const existing = await db.collection('playlists').findOne({
        username: update.username,
        _id: { $ne: toId(req.params.id) }
      });
      if (existing) {
        return res.status(400).json({ error: "Playlist username already in use" });
      }
    }

    await db.collection('playlists').updateOne(
      { _id: toId(req.params.id), userId: req.user!.id },
      { $set: update }
    );
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
    const { id } = req.params;

    await db.collection('playlists').updateOne(
      { _id: toId(id), userId: req.user!.id },
      { $set: { isSynced: true } }
    );

    // Clear existing mappings and create new ones with original upstream IDs
    await db.collection('mappings').deleteMany({ playlistId: id });

    res.json({ success: true, message: "Playlist marked as synced. Re-import streams to apply." });
  });

  router.delete("/playlists/:id", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const playlistId = req.params.id;
    // Delete playlist and its mappings
    await Promise.all([
      db.collection('playlists').deleteOne({ _id: toId(playlistId), userId: req.user!.id }),
      db.collection('mappings').deleteMany({ playlistId }),
      db.collection('categoryMappings').deleteMany({ playlistId }),
    ]);
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
      const playlistDoc = await db.collection('playlists').findOne({
        _id: toId(req.params.id),
        userId: req.user!.id,
      });
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
      const sourceIds: string[] = playlistDoc.sourceIds || [];
      for (let sourceIdx = 0; sourceIdx < sourceIds.length; sourceIdx++) {
        if (targetSIdx !== null && targetSIdx !== sourceIdx) continue;
        const sDoc = await db.collection('sources').findOne({ _id: toId(sourceIds[sourceIdx]) });
        if (!sDoc) continue;
        try {
          const client = new XtreamClient(sDoc as any);
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
      const playlistDoc = await db.collection('playlists').findOne({
        _id: toId(req.params.id),
        userId: req.user!.id,
      });
      if (!playlistDoc) return res.status(404).json({ error: 'Playlist not found' });

      const sourceIds: string[] = playlistDoc.sourceIds || [];
      const sourceDocs = await Promise.all(
        sourceIds.map((sid) => db.collection('sources').findOne({ _id: toId(sid) }))
      );
      const validSources = sourceDocs.filter(Boolean);

      const qLower = q.trim().toLowerCase();
      const seen = new Set<string>();
      const results: any[] = [];

      outer:
      for (const sourceDoc of validSources) {
        const sourceId = sourceDoc._id.toString();

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
      const playlistDoc = await db.collection('playlists').findOne({
        _id: toId(playlistId),
        userId: req.user!.id,
      });
      if (!playlistDoc) return res.status(404).json({ error: 'Playlist not found' });

      const sourceIds: string[] = playlistDoc.sourceIds || [];
      const sourceDocs = await Promise.all(
        sourceIds.map((sid) => db.collection('sources').findOne({ _id: toId(sid) }))
      );
      const validSources = sourceDocs.filter(Boolean);
      if (!validSources.length) return res.status(400).json({ error: 'No sources found' });

      // Use first available source; get container_extension from stream cache
      const sourceDoc = validSources[0]!;
      const cached = getCached(`${sourceDoc.id ?? sourceDoc._id.toString()}_streams_${type}`);
      const streamData = (cached?.data as any[] | undefined)?.find(
        (s: any) => String(s.stream_id ?? s.series_id) === streamId
      );
      const extension = streamData?.container_extension || 'mp4';
      const title = streamData?.name || streamData?.title || streamId;

      const url = buildStreamUrl(sourceDoc, streamId, type as 'vod' | 'series', extension);

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
