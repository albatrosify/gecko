import express, { Router } from "express";
import axios from "axios";
import http from "http";
import https from "https";
import dns from "dns";
import { getDb } from "../db.ts";
import { log } from "../logger.ts";
import { getClientInfo, proxyImageUrl, applyRegex, getBaseUrl, proxySeriesInfoImages, proxyXmlIcons } from "../utils.ts";
import { proxyStats } from "../proxy-stats.ts";
import { getGlobalQualityFormat } from "../quality-scan.ts";
import { DEFAULT_PORT } from "../config.ts";
import { refreshSource } from "../sync.ts";
import { getCached } from "../cache.ts";
import { XtreamClient } from "../xtream.ts";
import { Playlist, StreamMapping, CategoryMapping } from "../../src/types.ts";
import { computeDisplayName } from "../../src/quality.ts";

const isForbiddenIP = (ip: string): boolean => {
  const normalizedIP = ip.toLowerCase();
  if (
    normalizedIP === 'localhost' ||
    normalizedIP.endsWith('.local') ||
    normalizedIP.includes('::ffff:')
  ) {
    return true;
  }

  return (
    normalizedIP.startsWith('127.') ||
    normalizedIP.startsWith('10.') ||
    normalizedIP.startsWith('192.168.') ||
    normalizedIP.startsWith('169.254.') ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(normalizedIP) ||
    normalizedIP === '::1' ||
    normalizedIP === '0.0.0.0' || normalizedIP.startsWith('0.') ||
    normalizedIP === '::' ||
    /^[fF][cCdD]/.test(normalizedIP) || // fc00::/7
    /^[fF][eE][89aAbB]/.test(normalizedIP) // fe80::/10
  );
};

const safeLookup = (hostname: string, options: dns.LookupOptions, callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void) => {
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return callback(err, address as any, family);
    const addrs = Array.isArray(address) ? address : [{ address, family }];

    for (const addr of addrs) {
      if (isForbiddenIP(addr.address)) {
        return callback(new Error('Access to local network is forbidden'), '', 0);
      }
    }
    callback(null, address as any, family);
  });
};

const safeHttpAgent = new http.Agent({ lookup: safeLookup as any });
const safeHttpsAgent = new https.Agent({ lookup: safeLookup as any });

export function createProxyRouter() {
  const router = Router();

  const findPlaylistByCredentials = async (username: string, password: string) => {
    const db = getDb();
    const { playlists: schemaPlaylists } = await import('../schema.ts');
    const { eq, and } = await import('drizzle-orm');
    const doc = db.select().from(schemaPlaylists).where(and(eq(schemaPlaylists.username, username), eq(schemaPlaylists.password, password))).get();
    if (!doc) return null;
    return { id: doc.id, userId: doc.userId, name: doc.name, username: doc.username, password: doc.password, sourceIds: doc.sourceIds, directStreams: doc.directStreams, ...(doc.extra as any || {}) };
  };

  // Proxy handling helper
  const handleStreamProxy = async (req: express.Request, res: express.Response, type: 'live' | 'movie' | 'series') => {
    const { username, password, streamId, ext } = req.params;

    const playlist = await findPlaylistByCredentials(username, password) as Playlist | null;
    if (!playlist) return res.status(403).send("Invalid credentials");

    const db = getDb();
    const sourceIds: string[] = playlist.sourceIds || [];
    if (!sourceIds.length) return res.status(400).send("No source configured");

    const globalFormat = await getGlobalQualityFormat();

    // Use integer stream ID directly (no underscore prefix)
    let originalId = streamId;

    // Look up stream mapping by raw upstream stream ID.
    const { mappings: schemaMappings, sources: schemaSources } = await import('../schema.ts');
    const { eq, and, inArray } = await import('drizzle-orm');
    const mappingTypeMap: Record<string, string> = { live: 'live', movie: 'vod', series: 'series' };
    const streamMappingDoc = db.select().from(schemaMappings).where(and(eq(schemaMappings.playlistId, String(playlist.id)), eq(schemaMappings.originalId, streamId), eq(schemaMappings.type, mappingTypeMap[type]))).get();
    const streamMapping = streamMappingDoc ? { ...streamMappingDoc, ...(streamMappingDoc.extra as any || {}) } : null;
    const streamName = streamMapping
      ? computeDisplayName(streamMapping as any, playlist.qualityLabelFormat, globalFormat)
      : `Stream ${streamId}`;

    const upstreamHeaders: Record<string, string> = {
      'User-Agent': (req.headers['user-agent'] as string) || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) IPTV-Proxy/1.0',
    };
    if (req.headers['range']) upstreamHeaders['Range'] = req.headers['range'] as string;

    // Use sourceIdx from the mapping to route to the correct upstream
    const sourceIdx = streamMapping?.sourceIdx ?? -1;
    const targetSourceIds = (sourceIdx >= 0 && sourceIdx < sourceIds.length)
      ? [sourceIds[sourceIdx]]
      : sourceIds;

    // Bulk fetch target sources to avoid N+1 queries
    const targetSourceDocs = targetSourceIds.length > 0
      ? db.select().from(schemaSources).where(inArray(schemaSources.id, targetSourceIds)).all()
      : [];
    const sourceMap = new Map(targetSourceDocs.map(doc => [doc.id, { ...doc, ...(doc.extra as any || {}) }]));

    // Try each source in order, fall back to the next on failure
    let lastError = '';
    for (const sourceId of targetSourceIds) {
      const sourceDoc = sourceMap.get(sourceId);
      if (!sourceDoc) continue;

      const upstreamUrl = ext
        ? `${sourceDoc.url}/${type}/${sourceDoc.username}/${sourceDoc.password}/${originalId}.${ext}`
        : `${sourceDoc.url}/${type}/${sourceDoc.username}/${sourceDoc.password}/${originalId}`;

      try {
        const response = await axios({
          method: 'get',
          url: upstreamUrl,
          responseType: 'stream',
          timeout: 15000,
          headers: upstreamHeaders,
          validateStatus: () => true,
        });

        // Treat 4xx/5xx from upstream as a failure — try next source
        if (response.status >= 400) {
          lastError = `upstream returned ${response.status}`;
          if (response.data?.destroy) response.data.destroy();
          log(`[Proxy] Source ${sourceId} failed (${response.status}) for ${type}/${streamId}, trying next... - ${getClientInfo(req)}`);
          continue;
        }

        log(`[Proxy] ${type}/${streamId} for ${username} via source ${sourceId} - ${getClientInfo(req)}`);

        // Forward status code (206 for range requests) and headers
        res.status(response.status);
        const forwardHeaders = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control'];
        for (const h of forwardHeaders) {
          if (response.headers[h]) res.setHeader(h, response.headers[h]);
        }

        // Track stats
        const connId = Math.random().toString(36).substring(7);
        const connectionInfo = {
          id: connId,
          username,
          streamId,
          streamName,
          playlistName: (playlist as any).name || username,
          type,
          ip: req.ip || req.headers['x-forwarded-for']?.toString() || 'unknown',
          startTime: Date.now(),
          bytesRead: 0,
          intervalBytes: 0,
          currentBps: 0,
          proxied: true,
        };

        proxyStats.connections.set(connId, connectionInfo);
        proxyStats.activeStreams++;

        response.data.on('data', (chunk: Buffer) => {
          proxyStats.totalBytes += chunk.length;
          proxyStats.intervalBytes += chunk.length;
          connectionInfo.bytesRead += chunk.length;
          connectionInfo.intervalBytes += chunk.length;
        });

        response.data.pipe(res);

        const cleanup = () => {
          if (proxyStats.connections.has(connId)) {
            proxyStats.connections.delete(connId);
            proxyStats.activeStreams = Math.max(0, proxyStats.activeStreams - 1);
          }
          if (response.data?.destroy) response.data.destroy();
        };

        res.on('finish', cleanup);
        res.on('close', cleanup);
        response.data.on('error', cleanup);
        return; // success — stop trying sources
      } catch (err: any) {
        lastError = err.message;
        log(`[Proxy] Source ${sourceId} error for ${type}/${streamId}: ${err.message}, trying next... - ${getClientInfo(req)}`);
      }
    }

    log(`[Proxy] All sources failed for ${type}/${streamId}: ${lastError} - ${getClientInfo(req)}`);
    res.status(502).send("All upstream sources failed");
  };

  // Stream proxy routes — all traffic flows through this server (required for VPN routing)
  // Extension routes must be registered before extensionless so Express matches them first
  router.get("/live/:username/:password/:streamId.:ext", (req, res) => handleStreamProxy(req, res, 'live'));
  router.get("/movie/:username/:password/:streamId.:ext", (req, res) => handleStreamProxy(req, res, 'movie'));
  router.get("/series/:username/:password/:streamId.:ext", (req, res) => handleStreamProxy(req, res, 'series'));
  router.get("/live/:username/:password/:streamId", (req, res) => handleStreamProxy(req, res, 'live'));
  router.get("/movie/:username/:password/:streamId", (req, res) => handleStreamProxy(req, res, 'movie'));
  router.get("/series/:username/:password/:streamId", (req, res) => handleStreamProxy(req, res, 'series'));

  // Timeshift proxy — /timeshift/{username}/{password}/{duration}/{start}/{streamId}.{ext}
  router.get("/timeshift/:username/:password/:duration/:start/:streamId.:ext", async (req, res) => {
    const { username, password, duration, start, streamId, ext } = req.params;

    const playlist = await findPlaylistByCredentials(username, password) as Playlist | null;
    if (!playlist) return res.status(403).send("Invalid credentials");

    const db = getDb();
    const sourceId = playlist.sourceIds?.[0];
    if (!sourceId) return res.status(400).send("No source configured");

    const { sources: schemaSources } = await import('../schema.ts');
    const { eq } = await import('drizzle-orm');
    const sourceRow = db.select().from(schemaSources).where(eq(schemaSources.id, sourceId)).get();
    const sourceDoc = sourceRow ? { ...sourceRow, ...(sourceRow.extra as any || {}) } : null;
    if (!sourceDoc) return res.status(404).send("Source not found");

    const upstreamUrl = `${sourceDoc.url}/timeshift/${sourceDoc.username}/${sourceDoc.password}/${duration}/${start}/${streamId}.${ext}`;
    log(`[Timeshift] ${username} -> ${streamId} start=${start} dur=${duration}m - ${getClientInfo(req)}`);

    try {
      const response = await axios({
        method: 'get',
        url: upstreamUrl,
        responseType: 'stream',
        timeout: 15000,
        headers: { 'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 IPTV-Proxy/1.0' },
      });

      if (response.headers['content-type']) res.setHeader('Content-Type', response.headers['content-type']);
      if (response.headers['content-length']) res.setHeader('Content-Length', response.headers['content-length']);

      response.data.pipe(res);
      res.on('close', () => { if (response.data?.destroy) response.data.destroy(); });
    } catch (err: any) {
      log(`[Timeshift] Error: ${err.message} - ${getClientInfo(req)}`);
      res.status(502).send("Upstream timeshift error");
    }
  });


  // ── Image proxy — tunnels upstream thumbnails/logos through this server ──────
  // No auth: IPTV clients need to fetch thumbnails without credentials.
  router.get("/img", async (req, res) => {
    const { url } = req.query;
    if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      return res.status(400).send('Missing or invalid url');
    }
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
      if (isForbiddenIP(hostname)) {
        return res.status(403).send('Access to local network is forbidden');
      }
    } catch {
      return res.status(400).send('Invalid url');
    }

    try {
      const upstream = await axios.get(url, {
        responseType: 'stream',
        timeout: 10000,
        headers: { 'User-Agent': 'Mozilla/5.0' },
        httpAgent: safeHttpAgent,
        httpsAgent: safeHttpsAgent,
        beforeRedirect: (options: any) => {
          const redirectHostname = (options.hostname || options.host || '').replace(/^\[|\]$/g, '');
          if (isForbiddenIP(redirectHostname)) {
            throw new Error('Access to local network is forbidden');
          }
        }
      });
      const ct = upstream.headers['content-type'] || 'image/jpeg';
      res.set('Content-Type', ct);
      res.set('Cache-Control', 'public, max-age=86400');
      upstream.data.pipe(res);
    } catch (err: any) {
      if (err.message === 'Access to local network is forbidden') {
        return res.status(403).send('Access to local network is forbidden');
      }
      res.status(502).send('Failed to fetch image');
    }
  });

  router.get("/player_api.php", async (req: express.Request, res: express.Response) => {
    const { username, password, u, p, action } = req.query;

    // Support both full parameter names and Xtream API shortened names
    const actualUsername = username || u;
    const actualPassword = password || p;

    if (!actualUsername || !actualPassword) {
      return res.json({ status: "error", message: "Missing credentials" });
    }

    const playlist = await findPlaylistByCredentials(actualUsername as string, actualPassword as string) as Playlist | null;
    if (!playlist) {
      return res.json({ status: "error", message: "Invalid credentials" });
    }

    const db = getDb();
    const { sources: schemaSources, mappings: schemaMappings, categoryMappings: schemaCategoryMappings } = await import('../schema.ts');
    const { eq, inArray, and } = await import('drizzle-orm');

    // Bulk fetch all sources used in this playlist to avoid N+1 queries later.
    const playlistSourceIds = (Array.isArray(playlist.sourceIds) ? playlist.sourceIds : []) as string[];
    const sourceDocs = playlistSourceIds.length > 0
      ? db.select().from(schemaSources).where(inArray(schemaSources.id, playlistSourceIds)).all()
      : [];
    const sourcesMap = new Map(sourceDocs.map(s => [s.id, { ...s, ...(s.extra as any || {}) }]));

    // Load all category mappings (usually small) but defer stream mappings (can be huge)
    const catMappingDocs = db.select().from(schemaCategoryMappings).where(eq(schemaCategoryMappings.playlistId, playlist.id)).all();
    const catMappings = catMappingDocs.map(d => ({ id: d.id, playlistId: d.playlistId, type: d.type, originalId: d.originalId, ...(d.extra as any || {}) })) as CategoryMapping[];
    let mappings: StreamMapping[] = [];
    const globalFormat = await getGlobalQualityFormat();

    const sourceId = playlist.sourceIds?.[0];
    if (!sourceId) {
      return res.json({ status: "error", message: "No source configured for this playlist" });
    }

    const sourceDoc = sourcesMap.get(sourceId);
    if (!sourceDoc) {
      return res.json({ status: "error", message: "Source not found" });
    }
    const source = sourceDoc as any;
    const client = new XtreamClient(source);

    if (!action) {
      const auth = await client.authenticate();

      // Replace upstream credentials with this playlist's own credentials
      if (auth.user_info) {
        auth.user_info.username = playlist.username;
        auth.user_info.password = playlist.password;
      }

      if (auth.server_info) {
        const baseUrl = getBaseUrl(req);
        const parsed = new URL(baseUrl);
        auth.server_info.url = `${parsed.protocol}//${parsed.hostname}`;
        auth.server_info.port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
        auth.server_info.https_port = parsed.protocol === 'https:' ? (parsed.port || '443') : '443';
        auth.server_info.server_protocol = parsed.protocol.replace(':', '');
      }
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      return res.json(auth);
    }

    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    // Base URL for proxying image URLs through this server
    const imgBase = getBaseUrl(req);

    // Check if this action requires On-Demand Sync (Dynamic Sync)
    // If categories in this playlist have syncOnDemand, we refresh the source for that type
    const hasSyncOnDemandLive = catMappings.some(m => m.type === 'live' && m.syncOnDemand);
    const hasSyncOnDemandVod = catMappings.some(m => m.type === 'vod' && m.syncOnDemand);
    const hasSyncOnDemandSeries = catMappings.some(m => m.type === 'series' && m.syncOnDemand);

    // Dynamic Sync: block until all sources are synced before serving.
    // refreshSource has a 5-min cooldown, so upstream is only hit at most once per 5 minutes.
    if (action === 'get_live_streams' && hasSyncOnDemandLive)
      await Promise.all(playlist.sourceIds.map((sid: string) => refreshSource(sid, 'live').catch(() => {})));
    if (action === 'get_vod_streams' && hasSyncOnDemandVod)
      await Promise.all(playlist.sourceIds.map((sid: string) => refreshSource(sid, 'vod').catch(() => {})));
    if (action === 'get_series' && hasSyncOnDemandSeries)
      await Promise.all(playlist.sourceIds.map((sid: string) => refreshSource(sid, 'series').catch(() => {})));

    try {
      let data;
      switch (action) {
        case 'get_live_categories': {
          const allResults = await Promise.all(playlist.sourceIds.map(async (sid: string, sourceIdx: number) => {
            const catsCached = getCached(`${sid}_categories`);
            let cats: any[];
            if (catsCached?.data?.liveCats) {
              cats = catsCached.data.liveCats;
            } else {
              const sDoc = sourcesMap.get(sid);
              if (!sDoc) return [];
              cats = await new XtreamClient(sDoc as any).getLiveCategories().catch(() => []);
            }
            return cats.map((c: any) => ({ ...c, _sourceIdx: sourceIdx }));
          }));

          data = allResults.flat();

          const catMap = new Map(catMappings.filter(m => m.type === 'live').map(m => [String(m.originalId), m]));

          data.forEach((c: any, idx: number) => {
            const originalId = String(c.category_id || c.id);
            const prefixedId = `${c._sourceIdx}_${originalId}`;

            // Use prefixed ID for mapping lookup
            const mapping = catMap.get(prefixedId) || catMap.get(originalId);

            // Store order by prefixed ID for consistency
            c._order = mapping?.order ?? ((c._sourceIdx + 1) * 1000000 + idx);
            if (mapping?.customName) c.category_name = mapping.customName;
            c._hidden = mapping?.hidden || false;
            // Proxy category icon
            if (c.category_icon) c.category_icon = proxyImageUrl(c.category_icon, imgBase);
          });
          data = data.filter((c: any) => !c._hidden).sort((a: any, b: any) => a._order - b._order);
          // Strip source prefix from category_id only if it matches pattern ^\d+_
          data.forEach((c: any) => {
            if (c.category_id && /^\d+_/.test(String(c.category_id))) {
              c.category_id = String(c.category_id).split('_').slice(1).join('_');
            }
          });
          data.forEach((c: any) => { delete c._order; delete c._hidden; delete c._sourceIdx; });
          break;
        }
         case 'get_live_streams': {
           const categoryId = req.query.category_id as string;
           const mappingDocs = db.select().from(schemaMappings).where(and(eq(schemaMappings.playlistId, playlist.id), eq(schemaMappings.type, 'live'))).all();
           const allResults = await Promise.all(playlist.sourceIds.map(async (sid: string, sourceIdx: number) => {
               const sDoc = sourcesMap.get(sid);
               if (!sDoc) return [];
               const cl = new XtreamClient(sDoc as any);
               const streamsCached = getCached(`${sid}_streams_live`);
               const streams = streamsCached?.data ?? await cl.getLiveStreams().catch(() => []);
               return streams.map((s: any) => ({ ...s, _client: cl, _sourceIdx: sourceIdx }));
           }));

           mappings = mappingDocs.map(d => ({ id: d.id, playlistId: d.playlistId, type: d.type, originalId: d.originalId, ...(d.extra as any || {}) })) as StreamMapping[];
           data = allResults.flat();

           const catMap = new Map(catMappings.filter(m => m.type === 'live').map(m => [String(m.originalId), m]));
           const mappingMap = new Map(mappings.map(m => [String(m.originalId), m]));

           // Build category order map using PREFIXED category IDs for consistency
           const catOrderMap = new Map();
           const allCatsResults = await Promise.all(playlist.sourceIds.map(async (sid: string, sourceIdx: number) => {
             const catsCached = getCached(`${sid}_categories`);
             let cats: any[];
             if (catsCached?.data?.liveCats) {
               cats = catsCached.data.liveCats;
             } else {
               const sDoc = sourcesMap.get(sid);
               if (!sDoc) return [];
               cats = await new XtreamClient(sDoc as any).getLiveCategories().catch(() => []);
             }
             return cats.map((c: any) => ({ ...c, _sourceIdx: sourceIdx }));
           }));
           const deduplicatedCats = allCatsResults.flat();

           // Store order by PREFIXED category ID
           deduplicatedCats.forEach((c: any, idx: number) => {
             const originalId = String(c.category_id || c.id);
             const prefixedId = `${c._sourceIdx}_${originalId}`;
             catOrderMap.set(prefixedId, idx);
           });

           const seenStreams = new Set<string>();
           const filteredData = [];

           for (let idx = 0; idx < data.length; idx++) {
             const s = data[idx];
             const originalId = String(s.stream_id);

             if (seenStreams.has(originalId)) continue;
             seenStreams.add(originalId);

             const prefixedStreamId = `${s._sourceIdx}_${originalId}`;
             const mapping = mappingMap.get(prefixedStreamId) || mappingMap.get(originalId);
             if (mapping?.hidden) continue;

             // Determine target category ID (respect mapping override)
             let targetCatId = `${s._sourceIdx}_${String(s.category_id || '')}`;
             if (mapping?.categoryId) {
               targetCatId = mapping.categoryId;
             }

             // Check if the final category is hidden
             const catMapping = catMap.get(targetCatId) || (targetCatId.includes('_') ? catMap.get(targetCatId.split('_').slice(1).join('_')) : null);
             if (catMapping?.hidden) continue;

             // Apply category override to the stream object for output
             if (mapping?.categoryId) {
               s.category_id = mapping.categoryId;
             }

             // Filter by processed category_id (stripped prefix for Telvizo)
             if (categoryId && String(s.category_id) !== categoryId) continue;

             // Process names and icons
             if (mapping) {
               const baseName = computeDisplayName(mapping, playlist.qualityLabelFormat, globalFormat);
               s.name = (mapping.regexRenames && mapping.regexRenames.length > 0)
                 ? applyRegex(baseName, mapping.regexRenames)
                 : baseName;

               const resolvedIcon = mapping.customIcon || mapping.epgIcon;
               if (resolvedIcon) s.stream_icon = resolvedIcon;
               if (mapping.epgMapping) s.epg_channel_id = mapping.epgMapping;
               s.sourceIdx = mapping.sourceIdx ?? -1;
             }

             if (playlist.directStreams && s._client) {
               s.direct_source = s._client.getLiveStreamUrl(originalId);
             }

             s._catOrder = catOrderMap.get(targetCatId) ?? 2000000000;
             s._streamOrder = mapping?.order ?? idx;

             if (!playlist.isSynced) {
               s.streamId = String(mapping?.order ?? idx);
             }

             // Proxy icon and strip prefix
             if (s.stream_icon) s.stream_icon = proxyImageUrl(s.stream_icon, imgBase);
             if (s.category_id && /^\d+_/.test(String(s.category_id))) {
               s.category_id = String(s.category_id).split('_').slice(1).join('_');
             }

             // Cleanup
             delete s._client;
             delete s._sourceIdx;

             // Reduce payload size by removing empty/redundant fields
             if (s.epg_channel_id === "") delete s.epg_channel_id;
             if (s.stream_icon === "") delete s.stream_icon;
             if (s.added === "") delete s.added;
             if (s.custom_sid === "") delete s.custom_sid;
             if (s.tvg_name === s.name) delete s.tvg_name;

             filteredData.push(s);
           }

           data = filteredData.sort((a: any, b: any) => {
             if (a._catOrder !== b._catOrder) return a._catOrder - b._catOrder;
             return a._streamOrder - b._streamOrder;
           });

           for (const s of data) {
             delete s._catOrder;
             delete s._streamOrder;
           }
           break;
         }
          case 'get_vod_categories': {
            const allResults = await Promise.all(playlist.sourceIds.map(async (sid: string, sourceIdx: number) => {
              const catsCached = getCached(`${sid}_categories`);
              let cats: any[];
              if (catsCached?.data?.vodCats) {
                cats = catsCached.data.vodCats;
              } else {
                const sDoc = sourcesMap.get(sid);
                if (!sDoc) return [];
                cats = await new XtreamClient(sDoc as any).getVodCategories().catch(() => []);
              }
              return cats.map((c: any) => ({ ...c, _sourceIdx: sourceIdx }));
            }));

            data = allResults.flat();

            const catMap = new Map(catMappings.filter(m => m.type === 'vod').map(m => [String(m.originalId), m]));

            data.forEach((c: any, idx: number) => {
              const originalId = String(c.category_id || c.id);
              const prefixedId = `${c._sourceIdx}_${originalId}`;

              // Use prefixed ID for mapping lookup
              const mapping = catMap.get(prefixedId) || catMap.get(originalId);

              c._order = mapping?.order ?? idx;
              if (mapping?.customName) c.category_name = mapping.customName;
              c._hidden = mapping?.hidden || false;
              // Proxy category icon
              if (c.category_icon) c.category_icon = proxyImageUrl(c.category_icon, imgBase);
            });
            data = data.filter((c: any) => !c._hidden).sort((a: any, b: any) => a._order - b._order);
            // Strip source prefix from category_id only if it matches pattern ^\d+_
            data.forEach((c: any) => {
              if (c.category_id && /^\d+_/.test(String(c.category_id))) {
                c.category_id = String(c.category_id).split('_').slice(1).join('_');
              }
            });
            data.forEach((c: any) => { delete c._order; delete c._hidden; delete c._sourceIdx; });
            break;
          }
          case 'get_vod_streams': {
            const categoryId = req.query.category_id as string;
           const mappingDocs = db.select().from(schemaMappings).where(and(eq(schemaMappings.playlistId, playlist.id), eq(schemaMappings.type, 'vod'))).all();
           const allResults = await Promise.all(playlist.sourceIds.map(async (sid: string, sourceIdx: number) => {
               const sDoc = sourcesMap.get(sid);
               if (!sDoc) return [];
               const cl = new XtreamClient(sDoc as any);
               const streamsCached = getCached(`${sid}_streams_vod`);
               const streams = streamsCached?.data ?? await cl.getVodStreams().catch(() => []);
               return streams.map((s: any) => ({ ...s, _client: cl, _sourceIdx: sourceIdx }));
           }));

            mappings = mappingDocs.map(d => ({ id: d.id, playlistId: d.playlistId, type: d.type, originalId: d.originalId, ...(d.extra as any || {}) })) as StreamMapping[];
            data = allResults.flat();

            const catMap = new Map(catMappings.filter(m => m.type === 'vod').map(m => [String(m.originalId), m]));
           const mappingMap = new Map(mappings.map(m => [String(m.originalId), m]));

            // Build category order map using PREFIXED category IDs
            const catOrderMap = new Map();
            const allCatsResults = await Promise.all(playlist.sourceIds.map(async (sid: string, sourceIdx: number) => {
              const catsCached = getCached(`${sid}_categories`);
              let cats: any[];
              if (catsCached?.data?.vodCats) {
                cats = catsCached.data.vodCats;
              } else {
                const sDoc = sourcesMap.get(sid);
                if (!sDoc) return [];
                cats = await new XtreamClient(sDoc as any).getVodCategories().catch(() => []);
              }
              return cats.map((c: any) => ({ ...c, _sourceIdx: sourceIdx }));
            }));
            const deduplicatedCats = allCatsResults.flat();

            // Store order by PREFIXED category ID
            deduplicatedCats.forEach((c: any, idx: number) => {
              const originalId = String(c.category_id || c.id);
              const prefixedId = `${c._sourceIdx}_${originalId}`;
              catOrderMap.set(prefixedId, idx);
            });

            const seenStreams = new Set<string>();
            const filteredData = [];

            for (let idx = 0; idx < data.length; idx++) {
              const s = data[idx];
              const originalId = String(s.stream_id);

              if (seenStreams.has(originalId)) continue;
              seenStreams.add(originalId);

              const prefixedStreamId = `${s._sourceIdx}_${originalId}`;
              const mapping = mappingMap.get(prefixedStreamId) || mappingMap.get(originalId);
              if (mapping?.hidden) continue;

              // Determine target category ID (respect mapping override)
              let targetCatId = `${s._sourceIdx}_${String(s.category_id || '')}`;
              if (mapping?.categoryId) {
                targetCatId = mapping.categoryId;
              }

              // Check if the final category is hidden
              const catMapping = catMap.get(targetCatId) || (targetCatId.includes('_') ? catMap.get(targetCatId.split('_').slice(1).join('_')) : null);
              if (catMapping?.hidden) continue;

              // Apply category override to the stream object for output
              if (mapping?.categoryId) {
                s.category_id = mapping.categoryId;
              }

              // Filter by raw upstream category ID (Xtream sends raw IDs)
              if (categoryId && String(s.category_id) !== categoryId) continue;

              if (mapping) {
                const baseName = computeDisplayName(mapping, playlist.qualityLabelFormat, globalFormat);
                s.name = (mapping.regexRenames && mapping.regexRenames.length > 0)
                  ? applyRegex(baseName, mapping.regexRenames)
                  : baseName;
                s.sourceIdx = mapping.sourceIdx ?? -1;
              }

              s._catOrder = catOrderMap.get(targetCatId) ?? 2000000000;
              s._streamOrder = mapping?.order ?? idx;

              if (!playlist.isSynced) {
                s.streamId = String(mapping?.order ?? idx);
              }

              if (s.category_id && /^\d+_/.test(String(s.category_id))) {
                s.category_id = String(s.category_id).split('_').slice(1).join('_');
              }
              if (s.stream_icon) s.stream_icon = proxyImageUrl(s.stream_icon, imgBase);

              delete s._client;
              delete s._sourceIdx;

              // Reduce payload size
              if (s.stream_icon === "") delete s.stream_icon;
              if (s.added === "") delete s.added;

              filteredData.push(s);
            }

            data = filteredData.sort((a: any, b: any) => {
              if (a._catOrder !== b._catOrder) return a._catOrder - b._catOrder;
              return a._streamOrder - b._streamOrder;
            });

            for (const s of data) {
              delete s._catOrder;
              delete s._streamOrder;
            }
            break;
          }
          case 'get_series_categories': {
            const allResults = await Promise.all(playlist.sourceIds.map(async (sid: string, sourceIdx: number) => {
              const catsCached = getCached(`${sid}_categories`);
              let cats: any[];
              if (catsCached?.data?.seriesCats) {
                cats = catsCached.data.seriesCats;
              } else {
                const sDoc = sourcesMap.get(sid);
                if (!sDoc) return [];
                cats = await new XtreamClient(sDoc as any).getSeriesCategories().catch(() => []);
              }
              return cats.map((c: any) => ({ ...c, _sourceIdx: sourceIdx }));
            }));

            data = allResults.flat();

            const catMap = new Map(catMappings.filter(m => m.type === 'series').map(m => [String(m.originalId), m]));

            data.forEach((c: any, idx: number) => {
              const originalId = String(c.category_id || c.id);
              const prefixedId = `${c._sourceIdx}_${originalId}`;

              // Use prefixed ID for mapping lookup
              const mapping = catMap.get(prefixedId) || catMap.get(originalId);

              c._order = mapping?.order ?? idx;
              if (mapping?.customName) c.category_name = mapping.customName;
              c._hidden = mapping?.hidden || false;
              // Proxy category icon
              if (c.category_icon) c.category_icon = proxyImageUrl(c.category_icon, imgBase);
            });
            data = data.filter((c: any) => !c._hidden).sort((a: any, b: any) => a._order - b._order);
            // Strip source prefix from category_id only if it matches pattern ^\d+_
            data.forEach((c: any) => {
              if (c.category_id && /^\d+_/.test(String(c.category_id))) {
                c.category_id = String(c.category_id).split('_').slice(1).join('_');
              }
            });
            data.forEach((c: any) => { delete c._order; delete c._hidden; delete c._sourceIdx; });
            break;
          }
          case 'get_series': {
            const categoryId = req.query.category_id as string;
           const mappingDocs = db.select().from(schemaMappings).where(and(eq(schemaMappings.playlistId, playlist.id), eq(schemaMappings.type, 'series'))).all();
           const allResults = await Promise.all(playlist.sourceIds.map(async (sid: string, sourceIdx: number) => {
               const sDoc = sourcesMap.get(sid);
               if (!sDoc) return [];
               const cl = new XtreamClient(sDoc as any);
               const streamsCached = getCached(`${sid}_streams_series`);
               const streams = streamsCached?.data ?? await cl.getSeries().catch(() => []);
               return streams.map((s: any) => ({ ...s, _client: cl, _sourceIdx: sourceIdx }));
           }));

            mappings = mappingDocs.map(d => ({ id: d.id, playlistId: d.playlistId, type: d.type, originalId: d.originalId, ...(d.extra as any || {}) })) as StreamMapping[];
            data = allResults.flat();

            const catMap = new Map(catMappings.filter(m => m.type === 'series').map(m => [String(m.originalId), m]));
           const mappingMap = new Map(mappings.map(m => [String(m.originalId), m]));

            // Build category order map using PREFIXED category IDs
            const catOrderMap = new Map();
            const allCatsResults = await Promise.all(playlist.sourceIds.map(async (sid: string, sourceIdx: number) => {
              const catsCached = getCached(`${sid}_categories`);
              let cats: any[];
              if (catsCached?.data?.seriesCats) {
                cats = catsCached.data.seriesCats;
              } else {
                const sDoc = sourcesMap.get(sid);
                if (!sDoc) return [];
                cats = await new XtreamClient(sDoc as any).getSeriesCategories().catch(() => []);
              }
              return cats.map((c: any) => ({ ...c, _sourceIdx: sourceIdx }));
            }));
            const deduplicatedCats = allCatsResults.flat();

            // Store order by PREFIXED category ID
            deduplicatedCats.forEach((c: any, idx: number) => {
              const originalId = String(c.category_id || c.id);
              const prefixedId = `${c._sourceIdx}_${originalId}`;
              catOrderMap.set(prefixedId, idx);
            });

            const seenStreams = new Set<string>();
            const filteredData = [];

            for (let idx = 0; idx < data.length; idx++) {
              const s = data[idx];
              const sid = String(s.series_id);
              if (seenStreams.has(sid)) continue;
              seenStreams.add(sid);

              const prefixedStreamId = `${s._sourceIdx}_${sid}`;
              const mapping = mappingMap.get(prefixedStreamId) || mappingMap.get(sid);
              if (mapping?.hidden) continue;

              // Determine target category ID (respect mapping override)
              let targetCatId = `${s._sourceIdx}_${String(s.category_id || '')}`;
              if (mapping?.categoryId) {
                targetCatId = mapping.categoryId;
              }

              // Check if the final category is hidden
              const catMapping = catMap.get(targetCatId) || (targetCatId.includes('_') ? catMap.get(targetCatId.split('_').slice(1).join('_')) : null);
              if (catMapping?.hidden) continue;

              // Apply category override to the stream object for output
              if (mapping?.categoryId) {
                s.category_id = mapping.categoryId;
              }

              // Filter by raw upstream category ID (Xtream sends raw IDs)
              if (categoryId && String(s.category_id) !== categoryId) continue;

              if (mapping) {
                const baseName = computeDisplayName(mapping, playlist.qualityLabelFormat, globalFormat);
                s.name = (mapping.regexRenames && mapping.regexRenames.length > 0)
                  ? applyRegex(baseName, mapping.regexRenames)
                  : baseName;
                s.sourceIdx = mapping.sourceIdx ?? -1;
              }

              s._catOrder = catOrderMap.get(targetCatId) ?? 2000000000;
              s._streamOrder = mapping?.order ?? idx;

              if (!playlist.isSynced) {
                s.streamId = String(mapping?.order ?? idx);
              }

              if (s.category_id && /^\d+_/.test(String(s.category_id))) {
                s.category_id = String(s.category_id).split('_').slice(1).join('_');
              }
              if (s.cover) s.cover = proxyImageUrl(s.cover, imgBase);

              delete s._client;
              delete s._sourceIdx;

              // Reduce payload size
              if (s.cover === "") delete s.cover;
              if (s.last_modified === "") delete s.last_modified;

              filteredData.push(s);
            }

            data = filteredData.sort((a: any, b: any) => {
              if (a._catOrder !== b._catOrder) return a._catOrder - b._catOrder;
              return a._streamOrder - b._streamOrder;
            });

            for (const s of data) {
              delete s._catOrder;
              delete s._streamOrder;
            }
            break;
          }
      case 'get_live_info': {
            let liveStreamId = req.query.stream_id as string;
            // Try streamId first (new integer ID), then fall back to stream_id
            if (!liveStreamId && (req.body as any)?.streamId) liveStreamId = (req.body as any).streamId;
            // Use integer stream ID directly (no underscore prefix)
            const liveResults = await Promise.all(playlist.sourceIds.map(async (sid: string, sourceIdx: number) => {
             const sDoc = sourcesMap.get(sid);
             if (!sDoc) return null;
             const cl = new XtreamClient(sDoc as any);
             try { return await cl.getLiveInfo(liveStreamId); } catch { return null; }
           }));
           data = liveResults.find(r => r !== null) || {};
           if (data.info?.stream_icon) data.info.stream_icon = proxyImageUrl(data.info.stream_icon, imgBase);
           break;
         }

         case 'get_short_epg': {
            let epgStreamId = req.query.stream_id as string;
            // Try streamId first (new integer ID), then fall back to stream_id
            if (!epgStreamId && (req.body as any)?.streamId) epgStreamId = (req.body as any).streamId;
            // Use integer stream ID directly (no underscore prefix)
            const epgLimit = req.query.limit ? parseInt(req.query.limit as string) : undefined;
            const epgResults = await Promise.all(playlist.sourceIds.map(async (sid: string, sourceIdx: number) => {
             const sDoc = sourcesMap.get(sid);
             if (!sDoc) return null;
             const cl = new XtreamClient(sDoc as any);
             try {
               const r = await cl.getShortEpg(epgStreamId, epgLimit);
               if (r && (r.epg_listings?.length || r.length)) {
                 if (Array.isArray(r.epg_listings)) {
                   r.epg_listings.forEach((listing: any) => {
                     if (listing.icon) listing.icon = proxyImageUrl(listing.icon, imgBase);
                   });
                 }
                 return r;
               }
             } catch { return null; }
            return null;
          }));
          data = epgResults.find(r => r !== null) || { epg_listings: [] };
          break;
        }

        case 'get_simple_data_table': {
          let tableStreamId = req.query.stream_id as string;
          // Try streamId first (new integer ID), then fall back to stream_id
          if (!tableStreamId && (req.body as any)?.streamId) tableStreamId = (req.body as any).streamId;
          // Use integer stream ID directly (no underscore prefix)
          const tableResults = await Promise.all(playlist.sourceIds.map(async (sid: string, sourceIdx: number) => {
            const sDoc = sourcesMap.get(sid);
            if (!sDoc) return null;
            const cl = new XtreamClient(sDoc as any);
            try {
              const r = await cl.getSimpleDataTable(tableStreamId);
              if (r && (r.epg_listings?.length || r.length)) {
                if (Array.isArray(r.epg_listings)) {
                  r.epg_listings.forEach((listing: any) => {
                    if (listing.icon) listing.icon = proxyImageUrl(listing.icon, imgBase);
                  });
                }
                return r;
              }
            } catch { return null; }
            return null;
          }));
          data = tableResults.find(r => r !== null) || { epg_listings: [] };
          break;
        }

        case 'get_vod_info': {
          let vodId = req.query.vod_id as string;
          let targetSIdx: number | null = null;
          if (vodId.includes('_')) {
            const parts = vodId.split('_');
            targetSIdx = parseInt(parts[0]);
            vodId = parts.slice(1).join('_');
          }

          const allVodResults = await Promise.all(playlist.sourceIds.map(async (sid: string, sourceIdx: number) => {
            if (targetSIdx !== null && targetSIdx !== sourceIdx) return null;
            const sDoc = sourcesMap.get(sid);
            if (!sDoc) return null;
            const cl = new XtreamClient(sDoc as any);
            try {
              const info = await cl.getVodInfo(vodId);
              if (info && (info.info || info.movie_data)) return info;
            } catch (e) {
              return null;
            }
            return null;
          }));
          data = allVodResults.find(r => r !== null) || { error: "VOD not found" };
          if (data && !data.error) {
            if (data.info?.movie_image) data.info.movie_image = proxyImageUrl(data.info.movie_image, imgBase);
            if (data.movie_data?.stream_icon) data.movie_data.stream_icon = proxyImageUrl(data.movie_data.stream_icon, imgBase);
            if (Array.isArray(data.info?.backdrop_path)) {
              data.info.backdrop_path = data.info.backdrop_path.map((u: string) => proxyImageUrl(u, imgBase));
            } else if (data.info?.backdrop_path) {
              data.info.backdrop_path = proxyImageUrl(data.info.backdrop_path, imgBase);
            }
          }
          break;
        }

        case 'get_series_info': {
          let seriesId = req.query.series_id as string;
          let targetSIdx: number | null = null;
          if (seriesId.includes('_')) {
            const parts = seriesId.split('_');
            targetSIdx = parseInt(parts[0]);
            seriesId = parts.slice(1).join('_');
          }

          const allSourceResults = await Promise.all(playlist.sourceIds.map(async (sid: string, sourceIdx: number) => {
            if (targetSIdx !== null && targetSIdx !== sourceIdx) return null;
            const sDoc = sourcesMap.get(sid);
            if (!sDoc) return null;
            const cl = new XtreamClient(sDoc as any);
            try {
              const info = await cl.getSeriesInfo(seriesId);
              // Xtream API returns an object with "seasons" and "info" if found
              if (info && (info.seasons || info.episodes || info.info)) {
                return info;
              }
            } catch (e) {
              return null;
            }
            return null;
          }));

          // Return first one that has actual data
          data = allSourceResults.find(r => r !== null) || { error: "Series not found" };
          // Proxy image URLs in series info
          if (data && !data.error) {
            data = proxySeriesInfoImages(data, imgBase);
          }
          break;
        }
        default:
          data = { error: "Action not supported" };
      }
      res.json(data);
    } catch (error) {
      res.status(500).json({ error: "Upstream error" });
    }
  });

  // M3U Export
  router.get("/get.php", async (req, res) => {
    const { username, password, u, p, type } = req.query;

    // Support both full parameter names and Xtream API shortened names
    const actualUsername = username || u;
    const actualPassword = password || p;

    if (!actualUsername || !actualPassword) return res.status(400).send("Missing credentials");

    const playlist = await findPlaylistByCredentials(actualUsername as string, actualPassword as string) as Playlist | null;
    if (!playlist) return res.status(401).send("Invalid credentials");

    const db = getDb();
    const { sources: schemaSources, mappings: schemaMappings, categoryMappings: schemaCategoryMappings } = await import('../schema.ts');
    const { eq, inArray, and } = await import('drizzle-orm');

    // Bulk fetch all sources used in this playlist to avoid N+1 queries later.
    const playlistSourceIds = (Array.isArray(playlist.sourceIds) ? playlist.sourceIds : []) as string[];
    const sourceDocs = playlistSourceIds.length > 0
      ? db.select().from(schemaSources).where(inArray(schemaSources.id, playlistSourceIds)).all()
      : [];
    const m3uSourcesMap = new Map(sourceDocs.map(s => [s.id, { ...s, ...(s.extra as any || {}) }]));

    const m3uType = (type as string) || 'live';
    const activeTabStr = m3uType === 'vod' ? 'vod' : m3uType === 'series' ? 'series' : 'live';

    const mappingDocs = db.select().from(schemaMappings).where(and(eq(schemaMappings.playlistId, playlist.id), eq(schemaMappings.type, activeTabStr))).all();
    const catMappingDocs = db.select().from(schemaCategoryMappings).where(and(eq(schemaCategoryMappings.playlistId, playlist.id), eq(schemaCategoryMappings.type, activeTabStr))).all();

    const mappings = mappingDocs.map(d => ({ id: d.id, playlistId: d.playlistId, type: d.type, originalId: d.originalId, ...(d.extra as any || {}) })) as StreamMapping[];
    const catMappings = catMappingDocs.map(d => ({ id: d.id, playlistId: d.playlistId, type: d.type, originalId: d.originalId, ...(d.extra as any || {}) })) as CategoryMapping[];
    const m3uGlobalFormat = await getGlobalQualityFormat();

    try {
      let m3u = "#EXTM3U\n";

      const allResults = await Promise.all(playlist.sourceIds.map(async (sid: string, sourceIdx: number) => {
        const sDoc = m3uSourcesMap.get(sid);
        if (!sDoc) return [];
        const cl = new XtreamClient(sDoc as any);
        const cacheType = m3uType === 'vod' ? 'vod' : m3uType === 'series' ? 'series' : 'live';
        const streamsCached = getCached(`${sid}_streams_${cacheType}`);
        let streams: any[];
        if (streamsCached?.data) {
          streams = streamsCached.data;
        } else if (m3uType === 'vod') {
          streams = await cl.getMovies().catch(() => []);
        } else if (m3uType === 'series') {
          streams = await cl.getSeries().catch(() => []);
        } else {
          streams = await cl.getLiveStreams().catch(() => []);
        }
        return streams.map((s: any) => ({ ...s, _client: cl, _sourceIdx: sourceIdx }));
      }));

      let rawStreams = allResults.flat();

      const catMap = new Map(catMappings.filter(m => m.type === activeTabStr).map(m => [String(m.originalId), m]));
      const mappingMap = new Map(mappings.filter(m => m.type === activeTabStr).map(m => [String(m.originalId), m]));

      // Build category order map
      const catOrderMap = new Map();
      const allCatsResults = await Promise.all(playlist.sourceIds.map(async (sid: string, sourceIdx: number) => {
        const catsCached = getCached(`${sid}_categories`);
        let cats: any[];
        if (catsCached?.data) {
          const key = m3uType === 'vod' ? 'vodCats' : m3uType === 'series' ? 'seriesCats' : 'liveCats';
          cats = catsCached.data[key] || [];
        } else {
          const sDoc = m3uSourcesMap.get(sid);
          if (!sDoc) return [];
          const cl = new XtreamClient(sDoc as any);
          if (m3uType === 'vod') cats = await cl.getVodCategories().catch(() => []);
          else if (m3uType === 'series') cats = await cl.getSeriesCategories().catch(() => []);
          else cats = await cl.getLiveCategories().catch(() => []);
        }
        return cats.map((c: any) => ({ ...c, _sourceIdx: sourceIdx }));
      }));
      const deduplicatedCats = allCatsResults.flat();

      // Build category order map using PREFIXED category IDs
      deduplicatedCats.forEach((c: any, idx: number) => {
        const originalCatId = String(c.category_id || c.id);
        const prefixedId = `${c._sourceIdx}_${originalCatId}`;

        const mapping = catMap.get(originalCatId);
        catOrderMap.set(prefixedId, {
          order: mapping?.order ?? idx,
          name: mapping?.customName || c.category_name,
          hidden: mapping?.hidden || false
        });
      });

      const seenStreams = new Set<string>();
      const streams = rawStreams.filter((s: any, idx: number) => {
        const originalId = String(s.stream_id || s.series_id);

        if (seenStreams.has(originalId)) return false;
        seenStreams.add(originalId);

        const mapping = mappingMap.get(originalId);
        if (mapping?.hidden) return false;

        // Use PREFIXED category ID for consistency (s.category_id is raw from upstream, never prefixed)
        const prefixedCatId = `${s._sourceIdx}_${String(s.category_id || '')}`;

        if (mapping?.categoryId && mapping.categoryId !== prefixedCatId) {
          s.category_id = mapping.categoryId;
        }

        const catInfo = catOrderMap.get(prefixedCatId);
        if (!catInfo || catInfo.hidden) return false;

        s._catOrder = catInfo.order;
        s._streamOrder = mapping?.order ?? idx;
        s._displayCategoryName = catInfo.name;
        s._mapping = mapping;
        s.sourceIdx = mapping?.sourceIdx ?? -1;
        return true;
      }).sort((a: any, b: any) => {
        if (a._catOrder !== b._catOrder) return a._catOrder - b._catOrder;
        return a._streamOrder - b._streamOrder;
      });

      // Only generate integer stream IDs for custom playlists (not synced)
       const streamsWithIds = !playlist.isSynced ? streams.map((s: any, idx: number) => {
         const streamId = (playlist.nextStreamId || 1) + idx;
         s.streamId = streamId;
         return s;
       }) : streams;

      // Build base URL for proxied streams
      const proxyBaseUrl = getBaseUrl(req);

      for (const stream of streamsWithIds) {
        const mapping = stream._mapping;
        const streamId = stream.streamId;

        const baseName = mapping
          ? computeDisplayName(mapping, playlist.qualityLabelFormat, m3uGlobalFormat)
          : (stream.name || stream.title);
        const name = mapping ? applyRegex(baseName, mapping.regexRenames || []) : baseName;
        const rawLogo = mapping?.customIcon || mapping?.epgIcon || stream.stream_icon || stream.cover;
        const logo = rawLogo ? proxyImageUrl(rawLogo, proxyBaseUrl) : '';
        const epgId = mapping?.epgMapping || stream.epg_channel_id;
        const categoryName = stream._displayCategoryName;

        let url;
        if (playlist.directStreams && stream._client) {
          const originalStreamId = String(stream.stream_id || stream.series_id);
          if (m3uType === 'vod') url = stream._client.getVodStreamUrl(originalStreamId, stream.container_extension);
          else if (m3uType === 'series') url = stream._client.getSeriesStreamUrl(originalStreamId, stream.container_extension);
          else url = stream._client.getLiveStreamUrl(originalStreamId);
        } else {
          const pathType = m3uType === 'vod' ? 'movie' : m3uType === 'series' ? 'series' : 'live';
          url = `${proxyBaseUrl}/${pathType}/${playlist.username}/${playlist.password}/${streamId}.ts`;
        }

        m3u += `#EXTINF:-1 tvg-id="${epgId || ''}" tvg-name="${stream.name || stream.title || ''}" tvg-logo="${logo || ''}" group-title="${categoryName || ''}",${name}\n`;
        m3u += `${url}\n`;
      }
      res.setHeader('Content-Type', 'text/plain');
      res.send(m3u);
    } catch (error) {
      res.status(500).send("Error generating playlist");
    }
  });


  // EPG Export — fetches and merges all EPG sources for the playlist
  router.get("/xmltv.php", async (req, res) => {
    const { username, password } = req.query;
    if (!username || !password) return res.status(400).send("Missing credentials");

    const playlist = await findPlaylistByCredentials(username as string, password as string) as Playlist | null;
    if (!playlist) return res.status(401).send("Invalid credentials");

    const db = getDb();
    const imgBase = getBaseUrl(req);

    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');

    try {
      const fetchXml = async (url: string): Promise<string | null> => {
        try {
          const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
          let data = Buffer.from(response.data);
          if (url.endsWith('.gz') || response.headers['content-encoding'] === 'gzip') {
            const zlib = await import('zlib');
            data = zlib.gunzipSync(data);
          }
          return data.toString('utf-8');
        } catch (err: any) {
          log(`[EPG] Failed to fetch ${url}: ${err.message}`);
          return null;
        }
      };

      const xmlParts: string[] = [];

      const { epgs: schemaEpgs, sources: schemaSources } = await import('../schema.ts');
      const { inArray } = await import('drizzle-orm');

      // 1. Custom EPG sources linked to this playlist
      const epgIds: string[] = playlist.epgIds || [];
      if (epgIds.length) {
        const epgDocs = db.select().from(schemaEpgs).where(inArray(schemaEpgs.id, epgIds)).all();
        for (const epgDoc of epgDocs) {
          if (!epgDoc.url) continue;
          const xml = await fetchXml(epgDoc.url);
          if (xml) xmlParts.push(xml);
        }
      }

      // 2. Upstream sources with useUpstreamEpg enabled
      const playlistSourceIds = (Array.isArray(playlist.sourceIds) ? playlist.sourceIds : []) as string[];
      const sourceDocs = playlistSourceIds.length > 0
        ? db.select().from(schemaSources).where(inArray(schemaSources.id, playlistSourceIds)).all()
        : [];

      for (const sourceRow of sourceDocs) {
        const sExtra = (sourceRow.extra as any) || {};
        if (!sExtra.useUpstreamEpg || !sourceRow.url || !sourceRow.username) continue;
        const upstreamEpgUrl = `${sourceRow.url}/xmltv.php?username=${encodeURIComponent(sourceRow.username)}&password=${encodeURIComponent(sourceRow.password!)}`;
        log(`[EPG] Fetching upstream EPG: ${sourceRow.url}/xmltv.php`);
        const xml = await fetchXml(upstreamEpgUrl);
        if (xml) xmlParts.push(xml);
      }

      if (!xmlParts.length) {
        return res.send('<?xml version="1.0" encoding="UTF-8"?><tv></tv>');
      }

      if (xmlParts.length === 1) {
        return res.send(proxyXmlIcons(xmlParts[0], imgBase));
      }

      // Merge: extract inner content from each XMLTV doc and wrap in a single <tv>
      // Use faster index lookup instead of global regex on massive strings
      const extractInnerTv = (xml: string) => {
        const startTag = xml.indexOf('<tv');
        if (startTag === -1) return '';
        const start = xml.indexOf('>', startTag) + 1;
        const end = xml.lastIndexOf('</tv>');
        if (start > 0 && end > start) {
          const inner = xml.slice(start, end);
          return proxyXmlIcons(inner, imgBase);
        }
        return '';
      };

      res.write(`<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n`);
      for (let i = 0; i < xmlParts.length; i++) {
        res.write(extractInnerTv(xmlParts[i]));
        if (i < xmlParts.length - 1) res.write('\n');
        // Help GC by clearing strings
        xmlParts[i] = "";
      }
      res.end(`\n</tv>`);
    } catch (err: any) {
      log(`[EPG] Export error: ${err.message} - ${getClientInfo(req)}`);
      res.status(502).send("Failed to fetch EPG data");
    }
  });

  return router;
}
