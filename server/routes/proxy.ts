import pLimit from "p-limit";
import express, { Router } from "express";
import axios from "axios";
import http from "http";
import https from "https";
import dns from "dns";
import { getDb, generateId } from "../db.ts";
import { log } from "../logger.ts";
import { getClientInfo, proxyImageUrl, applyRegex, getBaseUrl, proxySeriesInfoImages, proxyXmlIcons } from "../utils.ts";
import { proxyStats } from "../proxy-stats.ts";
import { getGlobalQualityFormat } from "../quality-scan.ts";
import { refreshSource } from "../sync.ts";
import { getCached } from "../cache.ts";
import { XtreamClient } from "../xtream.ts";
import { getActiveHostUrls, recordHostUse } from "../hosts.ts";
import { recordVpnBlock } from "../vpn.ts";
import { Playlist, StreamMapping, CategoryMapping } from "../../src/types.ts";
import { computeDisplayName } from "../../src/quality.ts";
import { connectionArbiter } from "../dvr/connection-arbiter.ts";
import { dvrRecorder, RECORDINGS_DIR } from "../dvr/recorder.ts";
import { servePlaceholderStream } from "../dvr/placeholder.ts";
import { streamHub } from "../multiplexer/stream-hub.ts";
import { evaluateStreamRequest } from "../multiplexer/stream-guard.ts";
import fs from "fs";
import path from "path";

const limit = pLimit(5);

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

    // Handle Gecko Recording playback under VOD / Movies
    if (type === 'movie' && streamId.startsWith('rec_')) {
      const recId = streamId.slice(4);
      const recording = dvrRecorder.getRecordingById(recId);
      if (!recording || !recording.filePath || !fs.existsSync(recording.filePath)) {
        return res.status(404).send("Recording file not found");
      }

      const stat = fs.statSync(recording.filePath);
      const fileSize = stat.size;
      const range = req.headers.range;

      if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunksize = (end - start) + 1;
        const file = fs.createReadStream(recording.filePath, { start, end });

        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunksize,
          'Content-Type': 'video/mp2t',
        });
        return file.pipe(res);
      } else {
        res.writeHead(200, {
          'Content-Length': fileSize,
          'Content-Type': 'video/mp2t',
          'Accept-Ranges': 'bytes',
        });
        return fs.createReadStream(recording.filePath).pipe(res);
      }
    }

    const db = getDb();
    const sourceIds: string[] = playlist.sourceIds || [];
    if (!sourceIds.length) return res.status(400).send("No source configured");

    const globalFormat = await getGlobalQualityFormat();

    // Use integer stream ID directly (no underscore prefix)
    let originalId = streamId;

    // Resolve custom category items first!
    const activeTab = type === 'live' ? 'live' : (type === 'movie' ? 'vod' : 'series');
    const { mappings: schemaMappings, sources: schemaSources, customCategoryItems: schemaCustomCategoryItems } = await import('../schema.ts');
    const { eq, and, inArray } = await import('drizzle-orm');

    const customItem = db.select().from(schemaCustomCategoryItems).where(and(eq(schemaCustomCategoryItems.playlistId, playlist.id), eq(schemaCustomCategoryItems.streamId, streamId))).get();
    if (customItem) {
      const targetOriginalId = customItem.upstreamStreamId;
      const targetSourceId = customItem.upstreamSourceId;
      const sourceRow = db.select().from(schemaSources).where(eq(schemaSources.id, targetSourceId)).get();
      if (!sourceRow) return res.status(404).send("Custom item source not found");
      const overrides = (playlist as any).sourceOverrides?.[sourceRow.id];
      const effectiveUsername = overrides?.username || sourceRow.username;
      const effectivePassword = overrides?.password || sourceRow.password;
      const cl = new XtreamClient({ ...sourceRow, username: effectiveUsername, password: effectivePassword } as any);
      const targetExt = ext || (type === 'live' ? 'ts' : 'mp4');
      const targetUrl = type === 'live' ? cl.getLiveStreamUrl(targetOriginalId) : (type === 'movie' ? cl.getVodStreamUrl(targetOriginalId, targetExt) : cl.getSeriesStreamUrl(targetOriginalId, targetExt));
      return res.redirect(targetUrl);
    }

    // Look up stream mapping by raw upstream stream ID.
    const mappingTypeMap: Record<string, string> = { live: 'live', movie: 'vod', series: 'series' };
    const streamMappingDoc = db.select().from(schemaMappings).where(and(eq(schemaMappings.playlistId, String(playlist.id)), eq(schemaMappings.originalId, streamId), eq(schemaMappings.type, mappingTypeMap[type]))).get();
    const streamMapping = streamMappingDoc ? { ...streamMappingDoc, ...(streamMappingDoc.extra as any || {}) } : null;
    const mappedName = streamMapping
      ? computeDisplayName(streamMapping as any, playlist.qualityLabelFormat, globalFormat)
      : null;
    const streamName = (mappedName && mappedName.trim()) ? mappedName : `Stream ${streamId}`;

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
    let lastStatus = 502;
    for (const sourceId of targetSourceIds) {
      const sourceDoc = sourceMap.get(sourceId);
      if (!sourceDoc) continue;

      // Concurrency Guard & Multiplexing Check
      if (type === 'live') {
        const activeOnSource = streamHub.getActiveChannelsForSource(sourceId);
        const guardDecision = evaluateStreamRequest(sourceDoc, originalId, activeOnSource);

        if (guardDecision.action === 'block_placeholder') {
          return servePlaceholderStream(
            req,
            res,
            {
              sourceId,
              streamId: guardDecision.activeStreamId || '',
              streamName: guardDecision.activeStreamName,
              recordingId: '',
              lockedAt: Date.now(),
            },
            originalId,
            streamName,
            (playlist as any).name || username,
            username
          );
        }

        if (guardDecision.action === 'join_existing' && guardDecision.existingChannelKey) {
          const subId = generateId();
          const joined = streamHub.addSubscriber(guardDecision.existingChannelKey, {
            id: subId,
            req,
            res,
            username,
            playlistName: (playlist as any).name || username,
            ip: req.ip || req.headers['x-forwarded-for']?.toString() || 'unknown',
            startTime: Date.now(),
          });
          if (joined) {
            log(`[Proxy] Client ${username} joined existing shared stream for ${type}/${streamId} (0 extra upstream connections) - ${getClientInfo(req)}`);
            return;
          }
          log(`[Proxy] Shared stream ${guardDecision.existingChannelKey} closed before join; falling back to upstream - ${getClientInfo(req)}`);
        }
      }

      const overrideUsername = (playlist as any).sourceOverrides?.[sourceId]?.username || sourceDoc.username;
      const overridePassword = (playlist as any).sourceOverrides?.[sourceId]?.password || sourceDoc.password;

      // Try each host of this source in order (primary first), falling back on failure
      const hostUrls = getActiveHostUrls(sourceDoc);

      for (const hostUrl of hostUrls) {
        const safeExt = ext && /^[a-zA-Z0-9]{1,8}$/.test(ext) ? ext : null;
        const encUser = encodeURIComponent(overrideUsername);
        const encPass = encodeURIComponent(overridePassword);
        const encId = encodeURIComponent(originalId);
        const upstreamUrl = safeExt
          ? `${hostUrl}/${type}/${encUser}/${encPass}/${encId}.${safeExt}`
          : `${hostUrl}/${type}/${encUser}/${encPass}/${encId}`;

        try {
          const response = await axios({
            method: 'get',
            url: upstreamUrl,
            responseType: 'stream',
            timeout: 15000,
            headers: upstreamHeaders,
            validateStatus: () => true,
          });

          // Treat 4xx/5xx from upstream as a failure — try next host/source
          if (response.status >= 400) {
            lastStatus = response.status;
            if (response.status === 511) {
              lastError = 'Blocked by upstream CDN (HTTP 511: VPN/Datacenter IP blacklisted). Recommend rotating VPN.';
              recordVpnBlock(sourceId, hostUrl, 511, lastError);
              log(`[Proxy] ⚠️ Host ${hostUrl} BLOCKED by upstream CDN (511 Network Authentication Required) for ${type}/${streamId}. Egress IP appears blacklisted. Recommend rotating VPN. - ${getClientInfo(req)}`);
            } else {
              lastError = `upstream returned ${response.status}`;
              log(`[Proxy] Host ${hostUrl} failed (${response.status}) for ${type}/${streamId}, trying next... - ${getClientInfo(req)}`);
            }
            if (response.data?.destroy) response.data.destroy();
            recordHostUse(sourceId, hostUrl, false, lastError);
            continue;
          }

          log(`[Proxy] ${type}/${streamId} for ${username} via source ${sourceId} host ${hostUrl} - ${getClientInfo(req)}`);
          recordHostUse(sourceId, hostUrl, true);

          // Handle live stream multiplexing
          if (type === 'live') {
            const forwardHeaders: Record<string, string> = {};
            const headerKeys = ['content-type', 'accept-ranges', 'cache-control'];
            for (const h of headerKeys) {
              if (response.headers[h]) forwardHeaders[h] = response.headers[h];
            }

            const channel = streamHub.registerChannel(
              sourceId,
              originalId,
              streamName,
              type,
              hostUrl,
              response,
              forwardHeaders
            );

            const subId = generateId();
            streamHub.addSubscriber(channel.channelKey, {
              id: subId,
              req,
              res,
              username,
              playlistName: (playlist as any).name || username,
              ip: req.ip || req.headers['x-forwarded-for']?.toString() || 'unknown',
              startTime: Date.now(),
            });

            return; // success — stream multiplexer handles streaming and teardown
          }

          // Non-live (movies / series) standard 1:1 stream piping
          res.status(response.status);
          const forwardHeaders = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control'];
          for (const h of forwardHeaders) {
            if (response.headers[h]) res.setHeader(h, response.headers[h]);
          }

          const connId = generateId();
          const connectionInfo = {
            id: connId,
            sourceId,
            host: hostUrl,
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
          lastStatus = err.response?.status || (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT' ? 504 : 502);
          lastError = err.message;
          recordHostUse(sourceId, hostUrl, false, err.message);
          log(`[Proxy] Host ${hostUrl} error for ${type}/${streamId}: ${err.message}, trying next... - ${getClientInfo(req)}`);
        }
      }
    }

    log(`[Proxy] All sources failed for ${type}/${streamId}: ${lastError} (status ${lastStatus}) - ${getClientInfo(req)}`);
    if (lastStatus === 511) {
      res.status(511).send(`All upstream sources failed: Upstream CDN blocked connection (HTTP 511 Network Authentication Required). Server egress IP appears blacklisted. Please rotate VPN.`);
    } else {
      res.status(lastStatus).send(`All upstream sources failed: ${lastError}`);
    }
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

    const overrideUsername = (playlist as any).sourceOverrides?.[sourceId]?.username || sourceDoc.username;
    const overridePassword = (playlist as any).sourceOverrides?.[sourceId]?.password || sourceDoc.password;

    const hostUrls = getActiveHostUrls(sourceDoc);
    const baseUrl = hostUrls[0] || (sourceDoc.url ? (sourceDoc.url.startsWith('http') ? sourceDoc.url.replace(/\/+$/, '') : `http://${sourceDoc.url.replace(/\/+$/, '')}`) : '');
    if (!baseUrl) {
      return res.status(400).send("No source host configured");
    }
    const safeExt = /^[a-zA-Z0-9]{1,8}$/.test(ext) ? ext : 'ts';
    const upstreamUrl = `${baseUrl}/timeshift/${encodeURIComponent(overrideUsername)}/${encodeURIComponent(overridePassword)}/${duration}/${start}/${encodeURIComponent(streamId)}.${safeExt}`;
    log(`[Timeshift] ${username} -> ${streamId} start=${start} dur=${duration}m - ${getClientInfo(req)}`);

    try {
      const response = await axios({
        method: 'get',
        url: upstreamUrl,
        responseType: 'stream',
        timeout: 15000,
        headers: { 'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 IPTV-Proxy/1.0' },
        validateStatus: () => true,
      });

      if (response.status >= 400) {
        if (response.data?.destroy) response.data.destroy();
        log(`[Timeshift] Upstream failed (${response.status}) for ${username} -> ${streamId} - ${getClientInfo(req)}`);
        return res.status(response.status).send(`Upstream timeshift error: upstream returned ${response.status}`);
      }

      if (response.headers['content-type']) res.setHeader('Content-Type', response.headers['content-type']);
      if (response.headers['content-length']) res.setHeader('Content-Length', response.headers['content-length']);

      response.data.pipe(res);
      res.on('close', () => { if (response.data?.destroy) response.data.destroy(); });
    } catch (err: any) {
      log(`[Timeshift] Error: ${err.message} - ${getClientInfo(req)}`);
      const status = err.response?.status || (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT' ? 504 : 502);
      res.status(status).send(`Upstream timeshift error: ${err.message}`);
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
          let host = options.hostname;
          if (!host && options.host) {
            const match = options.host.match(/^\[([^\]]+)\](?::\d+)?$/) || options.host.match(/^([^:]+)(?::\d+)?$/);
            host = match ? match[1] : options.host;
          }
          const redirectHostname = (host || '').replace(/^\[|\]$/g, '');
          if (!redirectHostname || isForbiddenIP(redirectHostname)) {
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
      const is404 = err.response?.status === 404;
      const statusCode = is404 ? 404 : 502;
      // Cache 404 for 24h so clients don't hammer the server for dead logos;
      // cache transient 502 errors for 5 minutes.
      res.set('Cache-Control', is404 ? 'public, max-age=86400' : 'public, max-age=300');
      res.status(statusCode).send(is404 ? 'Image not found' : 'Failed to fetch image');
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
    const { sources: schemaSources, mappings: schemaMappings, categoryMappings: schemaCategoryMappings, customCategories: schemaCustomCategories, customCategoryItems: schemaCustomCategoryItems } = await import('../schema.ts');
    const { eq, inArray, and } = await import('drizzle-orm');

    // Bulk fetch all sources used in this playlist to avoid N+1 queries later.
    const playlistSourceIds = (Array.isArray(playlist.sourceIds) ? playlist.sourceIds : []) as string[];
    const sourceDocs = playlistSourceIds.length > 0
      ? db.select().from(schemaSources).where(inArray(schemaSources.id, playlistSourceIds)).all()
      : [];
    const sourcesMap = new Map(sourceDocs.map(s => {
      const baseSource = { ...s, ...(s.extra as any || {}) };
      const overrides = (playlist as any).sourceOverrides?.[s.id];
      if (overrides) {
        if (overrides.username) baseSource.username = overrides.username;
        if (overrides.password) baseSource.password = overrides.password;
      }
      return [s.id, baseSource];
    }));

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
      await Promise.all(playlist.sourceIds.map((sid: string) => limit(() => refreshSource(sid, 'live').catch(() => {}))));
    if (action === 'get_vod_streams' && hasSyncOnDemandVod)
      await Promise.all(playlist.sourceIds.map((sid: string) => limit(() => refreshSource(sid, 'vod').catch(() => {}))));
    if (action === 'get_series' && hasSyncOnDemandSeries)
      await Promise.all(playlist.sourceIds.map((sid: string) => limit(() => refreshSource(sid, 'series').catch(() => {}))));

    try {
      let data;
      switch (action) {
        case 'get_live_categories': {
          const allResults = await Promise.all(playlist.sourceIds.map((sid: string, sourceIdx: number) => limit(async () => {
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
          })));

          data = allResults.flat();

          const customCats = db.select().from(schemaCustomCategories).where(and(eq(schemaCustomCategories.playlistId, playlist.id), eq(schemaCustomCategories.type, 'live'))).all();
          customCats.forEach(cc => {
            if (!cc.hidden) {
              data.push({ category_id: `custom_${cc.id}`, category_name: cc.name, parent_id: 0, _order: cc.order, _hidden: false });
            }
          });

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
           const allResults = await Promise.all(playlist.sourceIds.map((sid: string, sourceIdx: number) => limit(async () => {
               const sDoc = sourcesMap.get(sid);
               if (!sDoc) return [];
               const cl = new XtreamClient(sDoc as any);
               const streamsCached = getCached(`${sid}_streams_live`);
               const streams = streamsCached?.data ?? await cl.getLiveStreams().catch(() => []);
               return streams.map((s: any) => ({ ...s, _client: cl, _sourceIdx: sourceIdx }));
           })));

           mappings = mappingDocs.map(d => ({ id: d.id, playlistId: d.playlistId, type: d.type, originalId: d.originalId, ...(d.extra as any || {}) })) as StreamMapping[];
           data = allResults.flat();

           const customItems = db.select().from(schemaCustomCategoryItems).where(and(eq(schemaCustomCategoryItems.playlistId, playlist.id), eq(schemaCustomCategoryItems.type, 'live'))).all();
           const liveSourceIdxMap = new Map(playlistSourceIds.map((id, idx) => [id, idx]));
           const liveDataMap = new Map(data.map((s: any) => [`${s._sourceIdx}_${s.stream_id}`, s]));
           const copiedStreams = customItems.map(item => {
             const sourceIdx = liveSourceIdxMap.get(item.upstreamSourceId);
             if (sourceIdx === undefined) return null;
             const original = liveDataMap.get(`${sourceIdx}_${item.upstreamStreamId}`);
             if (!original) return null;

             const clone = { ...(original as any), stream_id: item.streamId, category_id: `custom_${item.customCategoryId}`, _rawId: item.streamId, _isCopy: true };
             const extra = item.extra as any || {};
             if (extra.name) clone.name = extra.name;
             if (extra.stream_icon) clone.stream_icon = extra.stream_icon;
             return clone;
           }).filter(Boolean);
           data = [...data, ...copiedStreams];

           const catMap = new Map(catMappings.filter(m => m.type === 'live').map(m => [String(m.originalId), m]));
           const mappingMap = new Map(mappings.map(m => [String(m.originalId), m]));

           // Build category order map using PREFIXED category IDs for consistency
           const catOrderMap = new Map();
           const allCatsResults = await Promise.all(playlist.sourceIds.map((sid: string, sourceIdx: number) => limit(async () => {
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
           })));
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
            const allResults = await Promise.all(playlist.sourceIds.map((sid: string, sourceIdx: number) => limit(async () => {
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
            })));

            data = allResults.flat();

            const customCats = db.select().from(schemaCustomCategories).where(and(eq(schemaCustomCategories.playlistId, playlist.id), eq(schemaCustomCategories.type, 'vod'))).all();
            customCats.forEach(cc => {
              if (!cc.hidden) {
                data.push({ category_id: `custom_${cc.id}`, category_name: cc.name, parent_id: 0, _order: cc.order, _hidden: false });
              }
            });

            // Virtual category for Gecko DVR Recordings
            const dvrCatMapping = catMappings.find(m => m.type === 'vod' && m.originalId === 'gecko_recordings');
            if (!dvrCatMapping?.hidden) {
              data.push({
                category_id: 'gecko_recordings',
                category_name: dvrCatMapping?.customName || '📁 Gecko Recordings',
                parent_id: 0,
                _sourceIdx: -1,
                _order: dvrCatMapping?.order ?? -1,
                _hidden: false,
              });
            }

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
           const allResults = await Promise.all(playlist.sourceIds.map((sid: string, sourceIdx: number) => limit(async () => {
               const sDoc = sourcesMap.get(sid);
               if (!sDoc) return [];
               const cl = new XtreamClient(sDoc as any);
               const streamsCached = getCached(`${sid}_streams_vod`);
               const streams = streamsCached?.data ?? await cl.getVodStreams().catch(() => []);
               return streams.map((s: any) => ({ ...s, _client: cl, _sourceIdx: sourceIdx }));
           })));

            mappings = mappingDocs.map(d => ({ id: d.id, playlistId: d.playlistId, type: d.type, originalId: d.originalId, ...(d.extra as any || {}) })) as StreamMapping[];
            data = allResults.flat();

            const customItems = db.select().from(schemaCustomCategoryItems).where(and(eq(schemaCustomCategoryItems.playlistId, playlist.id), eq(schemaCustomCategoryItems.type, 'vod'))).all();
            const vodSourceIdxMap = new Map(playlistSourceIds.map((id, idx) => [id, idx]));
            const vodDataMap = new Map(data.map((s: any) => [`${s._sourceIdx}_${s.stream_id}`, s]));
            const copiedStreams = customItems.map(item => {
              const sourceIdx = vodSourceIdxMap.get(item.upstreamSourceId);
              if (sourceIdx === undefined) return null;
              const original = vodDataMap.get(`${sourceIdx}_${item.upstreamStreamId}`);
              if (!original) return null;
              const clone = { ...(original as any), stream_id: item.streamId, category_id: `custom_${item.customCategoryId}`, _rawId: item.streamId, _isCopy: true };
              const extra = item.extra as any || {};
              if (extra.name) clone.name = extra.name;
              if (extra.stream_icon) clone.stream_icon = extra.stream_icon;
              return clone;
            }).filter(Boolean);
            data = [...data, ...copiedStreams];

            const catMap = new Map(catMappings.filter(m => m.type === 'vod').map(m => [String(m.originalId), m]));
           const mappingMap = new Map(mappings.map(m => [String(m.originalId), m]));

            // Build category order map using PREFIXED category IDs
            const catOrderMap = new Map();
            const allCatsResults = await Promise.all(playlist.sourceIds.map((sid: string, sourceIdx: number) => limit(async () => {
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
            })));
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

            // Add completed Gecko DVR recordings
            const dvrCatMapping = catMappings.find(m => m.type === 'vod' && m.originalId === 'gecko_recordings');
            if (!dvrCatMapping?.hidden && (!categoryId || categoryId === 'gecko_recordings')) {
              const completedRecordings = dvrRecorder.getAllRecordings().filter(r => r.status === 'completed');
              completedRecordings.forEach((rec, recIdx) => {
                const addedSec = Math.floor(new Date(rec.startTime).getTime() / 1000).toString();
                filteredData.push({
                  num: filteredData.length + 1,
                  name: `${rec.streamName} (${new Date(rec.startTime).toLocaleDateString()})`,
                  stream_type: 'movie',
                  stream_id: `rec_${rec.id}`,
                  stream_icon: '',
                  rating: '',
                  rating_5based: 0,
                  added: addedSec,
                  category_id: 'gecko_recordings',
                  container_extension: 'ts',
                  custom_sid: null,
                  direct_source: '',
                  _catOrder: dvrCatMapping?.order ?? -1,
                  _streamOrder: recIdx,
                });
              });
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
            const allResults = await Promise.all(playlist.sourceIds.map((sid: string, sourceIdx: number) => limit(async () => {
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
            })));

            data = allResults.flat();

            const customCats = db.select().from(schemaCustomCategories).where(and(eq(schemaCustomCategories.playlistId, playlist.id), eq(schemaCustomCategories.type, 'series'))).all();
            customCats.forEach(cc => {
              if (!cc.hidden) {
                data.push({ category_id: `custom_${cc.id}`, category_name: cc.name, parent_id: 0, _order: cc.order, _hidden: false });
              }
            });

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
           const allResults = await Promise.all(playlist.sourceIds.map((sid: string, sourceIdx: number) => limit(async () => {
               const sDoc = sourcesMap.get(sid);
               if (!sDoc) return [];
               const cl = new XtreamClient(sDoc as any);
               const streamsCached = getCached(`${sid}_streams_series`);
               const streams = streamsCached?.data ?? await cl.getSeries().catch(() => []);
               return streams.map((s: any) => ({ ...s, _client: cl, _sourceIdx: sourceIdx }));
           })));

            mappings = mappingDocs.map(d => ({ id: d.id, playlistId: d.playlistId, type: d.type, originalId: d.originalId, ...(d.extra as any || {}) })) as StreamMapping[];
            data = allResults.flat();

            const customItems = db.select().from(schemaCustomCategoryItems).where(and(eq(schemaCustomCategoryItems.playlistId, playlist.id), eq(schemaCustomCategoryItems.type, 'series'))).all();
            const seriesSourceIdxMap = new Map(playlistSourceIds.map((id, idx) => [id, idx]));
            const seriesDataMap = new Map(data.map((s: any) => [`${s._sourceIdx}_${s.series_id}`, s]));
            const copiedStreams = customItems.map(item => {
              const sourceIdx = seriesSourceIdxMap.get(item.upstreamSourceId);
              if (sourceIdx === undefined) return null;
              const original = seriesDataMap.get(`${sourceIdx}_${item.upstreamStreamId}`);
              if (!original) return null;
              const clone = { ...(original as any), series_id: item.streamId, category_id: `custom_${item.customCategoryId}`, _rawId: item.streamId, _isCopy: true };
              const extra = item.extra as any || {};
              if (extra.name) clone.name = extra.name;
              if (extra.cover) clone.cover = extra.cover;
              return clone;
            }).filter(Boolean);
            data = [...data, ...copiedStreams];

            const catMap = new Map(catMappings.filter(m => m.type === 'series').map(m => [String(m.originalId), m]));
           const mappingMap = new Map(mappings.map(m => [String(m.originalId), m]));

            // Build category order map using PREFIXED category IDs
            const catOrderMap = new Map();
            const allCatsResults = await Promise.all(playlist.sourceIds.map((sid: string, sourceIdx: number) => limit(async () => {
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
            })));
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
            let liveStreamId = (req.query.stream_id || (req.body as any)?.streamId) as string | undefined;
            if (!liveStreamId || typeof liveStreamId !== 'string') {
              data = { error: "stream_id required" };
              break;
            }
            // Use integer stream ID directly (no underscore prefix)
            const liveResults = await Promise.all(playlist.sourceIds.map((sid: string, sourceIdx: number) => limit(async () => {
             const sDoc = sourcesMap.get(sid);
             if (!sDoc) return null;
             const cl = new XtreamClient(sDoc as any);
             try { return await cl.getLiveInfo(liveStreamId!); } catch { return null; }
           })));
           data = liveResults.find(r => r !== null) || {};
           if (data.info?.stream_icon) data.info.stream_icon = proxyImageUrl(data.info.stream_icon, imgBase);
           break;
         }

         case 'get_short_epg': {
            let epgStreamId = (req.query.stream_id || (req.body as any)?.streamId) as string | undefined;
            if (!epgStreamId || typeof epgStreamId !== 'string') {
              data = { epg_listings: [] };
              break;
            }
            // Use integer stream ID directly (no underscore prefix)
            const epgLimit = req.query.limit ? parseInt(req.query.limit as string) : undefined;
            const epgResults = await Promise.all(playlist.sourceIds.map((sid: string, sourceIdx: number) => limit(async () => {
             const sDoc = sourcesMap.get(sid);
             if (!sDoc) return null;
             const cl = new XtreamClient(sDoc as any);
             try {
               const r = await cl.getShortEpg(epgStreamId!, epgLimit);
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
          })));
          data = epgResults.find(r => r !== null) || { epg_listings: [] };
          break;
        }

        case 'get_simple_data_table': {
          let tableStreamId = (req.query.stream_id || (req.body as any)?.streamId) as string | undefined;
          if (!tableStreamId || typeof tableStreamId !== 'string') {
            data = { epg_listings: [] };
            break;
          }
          // Use integer stream ID directly (no underscore prefix)
          const tableResults = await Promise.all(playlist.sourceIds.map((sid: string, sourceIdx: number) => limit(async () => {
            const sDoc = sourcesMap.get(sid);
            if (!sDoc) return null;
            const cl = new XtreamClient(sDoc as any);
            try {
              const r = await cl.getSimpleDataTable(tableStreamId!);
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
          })));
          data = tableResults.find(r => r !== null) || { epg_listings: [] };
          break;
        }

        case 'get_vod_info': {
          let vodId = req.query.vod_id as string | undefined;
          if (!vodId || typeof vodId !== 'string') {
            data = { error: "vod_id required" };
            break;
          }

          if (vodId.startsWith('rec_')) {
            const recId = vodId.slice(4);
            const rec = dvrRecorder.getRecordingById(recId);
            if (rec) {
              data = {
                info: {
                  name: rec.streamName,
                  movie_image: '',
                  genre: 'Gecko Recordings',
                  plot: `Aufgenommen am ${new Date(rec.startTime).toLocaleString()}`,
                  duration_secs: rec.durationSeconds,
                  duration: `${Math.floor(rec.durationSeconds / 60)} min`,
                  releasedate: new Date(rec.startTime).toISOString().slice(0, 10),
                },
                movie_data: {
                  stream_id: `rec_${rec.id}`,
                  name: rec.streamName,
                  added: Math.floor(new Date(rec.startTime).getTime() / 1000).toString(),
                  category_id: 'gecko_recordings',
                  container_extension: 'ts',
                },
              };
              break;
            }
          }

          let targetSIdx: number | null = null;
          if (vodId.includes('_')) {
            const parts = vodId.split('_');
            targetSIdx = parseInt(parts[0]);
            vodId = parts.slice(1).join('_');
          }

          const allVodResults = await Promise.all(playlist.sourceIds.map((sid: string, sourceIdx: number) => limit(async () => {
            if (targetSIdx !== null && targetSIdx !== sourceIdx) return null;
            const sDoc = sourcesMap.get(sid);
            if (!sDoc) return null;
            const cl = new XtreamClient(sDoc as any);
            try {
              const info = await cl.getVodInfo(vodId!);
              if (info && (info.info || info.movie_data)) return info;
            } catch (e) {
              return null;
            }
            return null;
          })));
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
          let seriesId = req.query.series_id as string | undefined;
          if (!seriesId || typeof seriesId !== 'string') {
            data = { error: "series_id required" };
            break;
          }
          let targetSIdx: number | null = null;
          if (seriesId.includes('_')) {
            const parts = seriesId.split('_');
            targetSIdx = parseInt(parts[0]);
            seriesId = parts.slice(1).join('_');
          }

          const allSourceResults = await Promise.all(playlist.sourceIds.map((sid: string, sourceIdx: number) => limit(async () => {
            if (targetSIdx !== null && targetSIdx !== sourceIdx) return null;
            const sDoc = sourcesMap.get(sid);
            if (!sDoc) return null;
            const cl = new XtreamClient(sDoc as any);
            try {
              const info = await cl.getSeriesInfo(seriesId!);
              // Xtream API returns an object with "seasons" and "info" if found
              if (info && (info.seasons || info.episodes || info.info)) {
                return info;
              }
            } catch (e) {
              return null;
            }
            return null;
          })));

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
    const { sources: schemaSources, mappings: schemaMappings, categoryMappings: schemaCategoryMappings, customCategoryItems: schemaCustomCategoryItems } = await import('../schema.ts');
    const { eq, inArray, and } = await import('drizzle-orm');

    // Bulk fetch all sources used in this playlist to avoid N+1 queries later.
    const playlistSourceIds = (Array.isArray(playlist.sourceIds) ? playlist.sourceIds : []) as string[];
    const sourceDocs = playlistSourceIds.length > 0
      ? db.select().from(schemaSources).where(inArray(schemaSources.id, playlistSourceIds)).all()
      : [];
    const m3uSourcesMap = new Map(sourceDocs.map(s => {
      const baseSource = { ...s, ...(s.extra as any || {}) };
      const overrides = (playlist as any).sourceOverrides?.[s.id];
      if (overrides) {
        if (overrides.username) baseSource.username = overrides.username;
        if (overrides.password) baseSource.password = overrides.password;
      }
      return [s.id, baseSource];
    }));

    const m3uType = (type as string) || 'live';
    const activeTabStr = m3uType === 'vod' ? 'vod' : m3uType === 'series' ? 'series' : 'live';

    const mappingDocs = db.select().from(schemaMappings).where(and(eq(schemaMappings.playlistId, playlist.id), eq(schemaMappings.type, activeTabStr))).all();
    const catMappingDocs = db.select().from(schemaCategoryMappings).where(and(eq(schemaCategoryMappings.playlistId, playlist.id), eq(schemaCategoryMappings.type, activeTabStr))).all();

    const mappings = mappingDocs.map(d => ({ id: d.id, playlistId: d.playlistId, type: d.type, originalId: d.originalId, ...(d.extra as any || {}) })) as StreamMapping[];
    const catMappings = catMappingDocs.map(d => ({ id: d.id, playlistId: d.playlistId, type: d.type, originalId: d.originalId, ...(d.extra as any || {}) })) as CategoryMapping[];
    const m3uGlobalFormat = await getGlobalQualityFormat();

    try {
      let m3u = "#EXTM3U\n";

      const allResults = await Promise.all(playlist.sourceIds.map((sid: string, sourceIdx: number) => limit(async () => {
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
      })));

      let rawStreams = allResults.flat();

      const customItems = db.select().from(schemaCustomCategoryItems).where(and(eq(schemaCustomCategoryItems.playlistId, playlist.id), eq(schemaCustomCategoryItems.type, activeTabStr))).all();
      const m3uSourceIdxMap = new Map(playlistSourceIds.map((id, idx) => [id, idx]));
      const m3uDataMap = new Map(rawStreams.map((s: any) => [`${s._sourceIdx}_${s.stream_id}`, s]));
      const copiedStreams = customItems.map(item => {
        const sourceIdx = m3uSourceIdxMap.get(item.upstreamSourceId);
        if (sourceIdx === undefined) return null;
        const original = m3uDataMap.get(`${sourceIdx}_${item.upstreamStreamId}`);
        if (!original) return null;
        const clone = { ...(original as any), stream_id: item.streamId, category_id: `custom_${item.customCategoryId}`, _rawId: item.streamId, _isCopy: true };
        const extra = item.extra as any || {};
        if (extra.name) clone.name = extra.name;
        if (extra.stream_icon) clone.stream_icon = extra.stream_icon;
        return clone;
      }).filter(Boolean);
      rawStreams = [...rawStreams, ...copiedStreams];

      const catMap = new Map(catMappings.filter(m => m.type === activeTabStr).map(m => [String(m.originalId), m]));
      const mappingMap = new Map(mappings.filter(m => m.type === activeTabStr).map(m => [String(m.originalId), m]));

      // Build category order map
      const catOrderMap = new Map();
      const allCatsResults = await Promise.all(playlist.sourceIds.map((sid: string, sourceIdx: number) => limit(async () => {
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
      })));
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

      // Build base URL for proxied streams
      const proxyBaseUrl = getBaseUrl(req);

      for (const stream of streams) {
        const mapping = stream._mapping;
        const streamId = String(stream.stream_id || stream.series_id);

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
          if (m3uType === 'vod') url = stream._client.getVodStreamUrl(streamId, stream.container_extension);
          else if (m3uType === 'series') url = stream._client.getSeriesStreamUrl(streamId, stream.container_extension);
          else url = stream._client.getLiveStreamUrl(streamId);
        } else {
          const pathType = m3uType === 'vod' ? 'movie' : m3uType === 'series' ? 'series' : 'live';
          const streamExt = m3uType === 'live' ? 'ts' : (stream.container_extension || 'mp4');
          url = `${proxyBaseUrl}/${pathType}/${playlist.username}/${playlist.password}/${streamId}.${streamExt}`;
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
          let xml = data.toString('utf-8');
          // Fix unescaped & in attribute values from malformed upstream feeds
          xml = xml.replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);)/gi, '&amp;');
          return xml;
        } catch (err: any) {
          log(`[EPG] Failed to fetch ${url}: ${err.message}`);
          return null;
        }
      };

      const xmlParts: string[] = [];
      const fetchPromises: Promise<void>[] = [];

      const { epgs: schemaEpgs, sources: schemaSources } = await import('../schema.ts');
      const { inArray } = await import('drizzle-orm');

      // 1. Custom EPG sources linked to this playlist
      const epgIds: string[] = playlist.epgIds || [];
      if (epgIds.length) {
        const epgDocs = db.select().from(schemaEpgs).where(inArray(schemaEpgs.id, epgIds)).all();
        for (const epgDoc of epgDocs) {
          if (!epgDoc.url) continue;
          fetchPromises.push(fetchXml(epgDoc.url).then(xml => {
            if (xml) xmlParts.push(xml);
          }));
        }
      }

      // 2. Upstream sources with useUpstreamEpg enabled
      const playlistSourceIds = (Array.isArray(playlist.sourceIds) ? playlist.sourceIds : []) as string[];
      const sourceDocs = playlistSourceIds.length > 0
        ? db.select().from(schemaSources).where(inArray(schemaSources.id, playlistSourceIds)).all()
        : [];

      for (const sourceRow of sourceDocs) {
        const sExtra = (sourceRow.extra as any) || {};
        const overrides = (playlist as any).sourceOverrides?.[sourceRow.id];
        const effectiveUsername = overrides?.username || sourceRow.username;
        const effectivePassword = overrides?.password || sourceRow.password;

        if (!sExtra.useUpstreamEpg || !sourceRow.url || !effectiveUsername) continue;
        const upstreamEpgUrl = `${sourceRow.url}/xmltv.php?username=${encodeURIComponent(effectiveUsername)}&password=${encodeURIComponent(effectivePassword || '')}`;
        log(`[EPG] Fetching upstream EPG: ${sourceRow.url}/xmltv.php`);
        fetchPromises.push(fetchXml(upstreamEpgUrl).then(xml => {
          if (xml) xmlParts.push(xml);
        }));
      }

      await Promise.all(fetchPromises);

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
