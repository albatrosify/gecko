import express from "express";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import cron from "node-cron";
import { connectDb, getDb, toId, docWithId, docsWithId } from "./server/db.ts";
import { createAuthRouter, requireAuth, requireAuthOrQuery, AuthRequest } from "./server/auth.ts";
import { getCached, setCache, duplicateCache } from "./server/cache.ts";
import { XtreamClient } from "./server/xtream.ts";
import { Playlist, StreamMapping, CategoryMapping } from "./src/types.ts";
import axios from "axios";
import cronstrue from "cronstrue";
import { computeDisplayName } from './src/quality.ts';
import { probeStream } from './server/quality.ts';

const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LOG_PATH = path.join(process.cwd(), 'data', 'server.log');

// Ensure log file exists on start
function initLogFile() {
  const dir = path.dirname(LOG_PATH);
  console.log("Initializing log file at:", LOG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(LOG_PATH)) fs.writeFileSync(LOG_PATH, `[${new Date().toLocaleTimeString()}] System Started\n`);
  console.log("Log file ready.");
}
initLogFile();

function log(msg: string) {
  const time = new Date().toLocaleTimeString();
  const entry = `[${time}] ${msg}\n`;
  console.log(entry.trim());
  try {
    // Ensure parent dir exists
    const dir = path.dirname(LOG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(LOG_PATH, entry);
  } catch (e) {}
};

// Helper to apply regex
const applyRegex = (name: string, rules: { pattern: string; replacement: string }[]) => {
  let result = name;
  for (const rule of rules) {
    try {
      const regex = new RegExp(rule.pattern, 'g');
      result = result.replace(regex, rule.replacement);
    } catch (e) {
      console.error("Invalid regex:", rule.pattern);
    }
  }
  return result;
};

// Helper to compare data and generate a changelog
function getChangelog(oldItems: any[], newItems: any[], idField: string, nameField: string) {
  const oldMap = new Map((oldItems || []).map(i => [String(i[idField]), i]));
  const newMap = new Map((newItems || []).map(i => [String(i[idField]), i]));

  const added = newItems
    .filter(i => !oldMap.has(String(i[idField])))
    .map(i => ({ id: String(i[idField]), name: i[nameField] }));
    
  const removed = (oldItems || [])
    .filter(i => !newMap.has(String(i[idField])))
    .map(i => ({ id: String(i[idField]), name: i[nameField] }));
    
  const renamed = newItems
    .filter(i => {
      const old = oldMap.get(String(i[idField]));
      return old && old[nameField] !== i[nameField];
    })
    .map(i => ({ 
        id: String(i[idField]), 
        oldName: oldMap.get(String(i[idField]))[nameField], 
        newName: i[nameField] 
    }));

  return { added, removed, renamed };
}

async function getSnapshot(sourceId: string, type: string): Promise<any> {
  const db = getDb();
  const doc = await db.collection('source_snapshots').findOne({ sourceId, type });
  return doc?.snapshot ?? null;
}

async function setSnapshot(sourceId: string, type: string, snapshot: any): Promise<void> {
  const db = getDb();
  await db.collection('source_snapshots').updateOne(
    { sourceId, type },
    { $set: { snapshot, updatedAt: new Date().toISOString() } },
    { upsert: true }
  );
}

async function recordSourceChanges(sourceId: string, type: string, oldData: any, newData: any) {
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

// =====================================
// Source Sync & Cron Management
// =====================================
async function refreshSource(sourceId: string, type: 'live' | 'vod' | 'series' = 'live', force: boolean = false) {
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

  console.log(`[Sync] Starting ${type} sync for: ${source.name}`);
  const client = new XtreamClient(source as any);
  
  try {
    let upstreamStreams: any[] = [];
    if (type === 'live') upstreamStreams = await client.getLiveStreams();
    else if (type === 'vod') upstreamStreams = await client.getMovies();
    else if (type === 'series') upstreamStreams = await client.getSeries();

    console.log(`[Sync] Fetched ${upstreamStreams.length} ${type} streams from upstream`);

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
      const upstream = streamMap.get(m.originalId) as any;
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

    console.log(`[Sync] Completed for ${source.name} (${type}). Updated ${updatedCount} name(s).`);

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
    console.log(`[Sync] Error for ${source.name} (${type}): ${err.message}`);
    return { error: err.message };
  }
}

const activeCrons = new Map<string, any>();

// ── Quality Scan Jobs ──────────────────────────────────────────────────────────
interface ScanJob {
  id: string;
  userId: string;
  status: 'running' | 'done' | 'cancelled';
  total: number;
  done: number;
  failed: number;
  results: { streamId: string; meta?: any; error?: string }[];
}
const scanJobs = new Map<string, ScanJob>();

// Module-level cache for global quality format (invalidated on PATCH /api/settings)
let _qualityFormatCache: { value: string; expiresAt: number } | null = null;

async function getGlobalQualityFormat(): Promise<string> {
  if (_qualityFormatCache && Date.now() < _qualityFormatCache.expiresAt) {
    return _qualityFormatCache.value;
  }
  const db = getDb();
  const doc = await db.collection('settings').findOne({ _id: 'global' as any });
  const value = (doc as any)?.qualityLabelFormat ?? '{surround::exists["[{surround}] "||""]}{hdr::exists["[{hdr}] "||""]}[{label}]';
  _qualityFormatCache = { value, expiresAt: Date.now() + 60_000 };
  return value;
}

function buildStreamUrl(sourceDoc: any, streamId: string, type: 'live' | 'vod' | 'series', extension?: string): string {
  const cl = new XtreamClient(sourceDoc as any);
  if (type === 'live') return cl.getLiveStreamUrl(streamId);
  if (type === 'vod') return cl.getVodStreamUrl(streamId, extension || 'mp4');
  return cl.getSeriesStreamUrl(streamId, extension || 'mp4');
}

async function initCronManager() {
  log("Initializing Source Cron Manager...");
  const db = getDb();
  const sources = await db.collection('sources').find({ autoSyncEnabled: true, syncCron: { $exists: true } }).toArray();
  
  for (const source of sources) {
    scheduleSourceCron(source);
  }
}

function scheduleSourceCron(source: any) {
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

async function startServer() {
  log("Starting server...");
  try {
    // Connect to MongoDB
    await connectDb();
    log("Connected to MongoDB");

    // Initialize cron jobs
    await initCronManager().catch(err => log(`[Cron] Initialization failed: ${err.message}`));

    const app = express();
    const PORT = parseInt(process.env.PORT || "3000");

    app.use(express.json({ limit: '50mb' }));

    // Health check — used by Docker healthcheck and monitoring
    app.get("/health", (_req, res) => res.json({ status: "ok" }));

    // Request logging middleware - registered first so all routes are logged
    app.use((req, res, next) => {
      const start = Date.now();
      res.on('finish', () => {
        // Skip logging the logs endpoint itself to avoid feedback loop
        if (req.path !== '/api/system/logs') {
          const duration = Date.now() - start;
          log(`${req.method} ${req.url} ${res.statusCode} ${duration}ms`);
        }
      });
      next();
    });

    // Public IP lookup (server-side so it reflects the VPN's IP)
    let ipCache: { data: any; expiresAt: number } | null = null;
    app.get("/api/system/ip", requireAuth, async (req, res) => {
      try {
        const now = Date.now();
        if (ipCache && now < ipCache.expiresAt) {
          return res.json(ipCache.data);
        }
        const response = await axios.get('http://ipinfo.io/json', { timeout: 10000 });
        const { ip, country, city, org } = response.data;
        const data = { ip, country, city, org };
        ipCache = { data, expiresAt: now + 30_000 };
        res.json(data);
      } catch (err: any) {
        res.status(502).json({ error: 'Failed to reach ipinfo.io: ' + err.message });
      }
    });

    // System Logs
    app.get("/api/system/logs", requireAuth, (req, res) => {
      try {
        if (!fs.existsSync(LOG_PATH)) return res.json({ logs: "" });
        const data = fs.readFileSync(LOG_PATH, "utf-8");
        const lines = data.split("\n").filter(l => l.trim() !== "");
        const tail = lines.slice(-200).join("\n");
        res.json({ logs: tail });
      } catch (err: any) {
        res.status(500).json({ error: "Failed to read logs: " + err.message });
      }
    });

    app.get("/api/proxy/stats", requireAuth, async (req, res) => {
      try {
        const db = getDb();
        const [playlistsCount, usersCount, directStreamsCount] = await Promise.all([
          db.collection('playlists').countDocuments(),
          db.collection('users').countDocuments(),
          db.collection('playlists').countDocuments({ directStreams: true }),
        ]);

        res.json({
          activeStreams: proxyStats.activeStreams,
          totalBytes: proxyStats.totalBytes,
          currentBps: proxyStats.currentBps,
          history: proxyStats.history,
          totalPlaylists: playlistsCount,
          totalUsers: usersCount,
          directStreamsCount,
          connections: Array.from(proxyStats.connections.values()),
        });
      } catch (err: any) {
        res.status(500).json({ error: 'Failed to fetch stats' });
      }
    });

    // Auth routes
    app.use('/api/auth', createAuthRouter());

    // Health check
    app.get("/api/health", (req, res) => {
      res.json({ status: "ok" });
    });

    app.get("/api/version", (req, res) => {
      res.json({ version: pkg.version });
    });

    // =====================================
    // Admin: User Management
    // =====================================
    app.get("/api/admin/users", requireAuth, async (req: AuthRequest, res) => {
      if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: "Admin access required" });
      }
      const db = getDb();
      const users = await db.collection('users').find({}, { projection: { password: 0 } }).toArray();
      
      const userList = await Promise.all(users.map(async (u) => {
        const playlistCount = await db.collection('playlists').countDocuments({ userId: u._id.toString() });
        return {
          ...docWithId(u),
          playlistCount
        };
      }));

      res.json(userList);
    });

    app.delete("/api/admin/users/:id", requireAuth, async (req: AuthRequest, res) => {
      if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: "Admin access required" });
      }
      const db = getDb();
      const userId = req.params.id;

      if (userId === req.user.id) {
        return res.status(400).json({ error: "Cannot delete yourself" });
      }

      // Cascade delete
      const userPlaylists = await db.collection('playlists').find({ userId }).toArray();
      const playlistIds = userPlaylists.map(p => p._id.toString());

      await Promise.all([
        db.collection('users').deleteOne({ _id: toId(userId) }),
        db.collection('playlists').deleteMany({ userId }),
        db.collection('mappings').deleteMany({ playlistId: { $in: playlistIds } }),
        db.collection('categoryMappings').deleteMany({ playlistId: { $in: playlistIds } }),
        db.collection('sources').deleteMany({ userId })
      ]);

      log(`Admin deleted user ${userId} and all associated data`);
      res.json({ success: true });
    });

    // =====================================
    // CRUD: Sources
    // =====================================
    app.get("/api/sources", requireAuth, async (req: AuthRequest, res) => {
      const db = getDb();
      const docs = await db.collection('sources').find({ userId: req.user!.id }).toArray();
      res.json(docsWithId(docs));
    });

    app.post("/api/sources", requireAuth, async (req: AuthRequest, res) => {
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

    app.put("/api/sources/:id", requireAuth, async (req: AuthRequest, res) => {
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

    app.post("/api/sources/:id/refresh", requireAuth, async (req: AuthRequest, res) => {
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

    app.get("/api/sources/:id/changelog", requireAuth, async (req: AuthRequest, res) => {
      const db = getDb();
      const logs = await db.collection('source_changelogs')
        .find({ sourceId: req.params.id })
        .sort({ timestamp: -1 })
        .limit(20)
        .toArray();
      res.json(logs);
    });

    app.delete("/api/sources/:id", requireAuth, async (req: AuthRequest, res) => {
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
    // CRUD: EPGs
    // =====================================
    app.get("/api/epgs", requireAuth, async (req: AuthRequest, res) => {
      const db = getDb();
      const docs = await db.collection('epgs').find({ userId: req.user!.id }).toArray();
      res.json(docsWithId(docs));
    });

    app.post("/api/epgs", requireAuth, async (req: AuthRequest, res) => {
      const db = getDb();
      const epg = {
        ...req.body,
        userId: req.user!.id,
        enabled: true,
      };
      const result = await db.collection('epgs').insertOne(epg);
      res.status(201).json({ id: result.insertedId.toString(), ...epg });
    });

    app.delete("/api/epgs/:id", requireAuth, async (req: AuthRequest, res) => {
      const db = getDb();
      await db.collection('epgs').deleteOne({ _id: toId(req.params.id), userId: req.user!.id });
      res.json({ success: true });
    });

    // EPG channel list — parses <channel> elements from all EPG sources for a playlist.
    // Only reads up to the first <programme> tag so large files are fast.
    // Cached in-memory per playlist for 1 hour.
    const epgChannelCache = new Map<string, { channels: {id: string; name: string; icon?: string; source: string}[]; expiresAt: number }>();

    app.get("/api/epg-channels", requireAuth, async (req: AuthRequest, res) => {
      const { playlistId } = req.query;
      if (!playlistId) return res.status(400).json({ error: 'playlistId required' });

      const cached = epgChannelCache.get(playlistId as string);
      if (cached && Date.now() < cached.expiresAt) return res.json({ channels: cached.channels });

      const db = getDb();
      const playlistDoc = await db.collection('playlists').findOne({ _id: toId(playlistId as string) });
      if (!playlistDoc) return res.status(404).json({ error: 'Playlist not found' });

      const fetchXmlHead = async (url: string): Promise<string> => {
        try {
          const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
          let data = Buffer.from(response.data);
          if (url.endsWith('.gz') || response.headers['content-encoding'] === 'gzip') {
            const zlib = await import('zlib');
            data = zlib.gunzipSync(data);
          }
          const text = data.toString('utf-8');
          const cutoff = text.indexOf('<programme');
          return cutoff > 0 ? text.slice(0, cutoff) : text;
        } catch { return ''; }
      };

      const xmlSources: { xml: string; sourceName: string }[] = [];

      // Custom EPG sources
      const epgIds: string[] = playlistDoc.epgIds || [];
      if (epgIds.length) {
        const epgDocs = await db.collection('epgs').find({ _id: { $in: epgIds.map(toId) } }).toArray();
        for (const e of epgDocs) {
          if (e.url) xmlSources.push({ xml: await fetchXmlHead(e.url), sourceName: e.name || e.url });
        }
      }

      // Upstream sources with useUpstreamEpg
      const sourceDocs = await db.collection('sources').find({
        _id: { $in: (playlistDoc.sourceIds || []).map(toId) },
        useUpstreamEpg: true,
      }).toArray();
      for (const s of sourceDocs) {
        if (s.url && s.username) {
          const url = `${s.url}/xmltv.php?username=${encodeURIComponent(s.username)}&password=${encodeURIComponent(s.password)}`;
          xmlSources.push({ xml: await fetchXmlHead(url), sourceName: `Upstream: ${s.name || s.url}` });
        }
      }

      // Parse <channel> elements, tag each with its source name
      const channels: {id: string; name: string; icon?: string; source: string}[] = [];
      const seen = new Set<string>();
      for (const { xml, sourceName } of xmlSources) {
        const channelRegex = /<channel\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/channel>/gi;
        let m;
        while ((m = channelRegex.exec(xml)) !== null) {
          const id = m[1];
          if (seen.has(id)) continue;
          seen.add(id);
          const nameMatch = /<display-name[^>]*>([^<]+)<\/display-name>/i.exec(m[2]);
          const iconMatch = /<icon\s+src="([^"]+)"/i.exec(m[2]);
          if (nameMatch) {
            channels.push({ id, name: nameMatch[1].trim(), icon: iconMatch?.[1], source: sourceName });
          }
        }
      }

      epgChannelCache.set(playlistId as string, { channels, expiresAt: Date.now() + 3600_000 });
      res.json({ channels });
    });

    // =====================================
    // CRUD: Playlists
    // =====================================
    app.post("/api/playlists/:id/clone", requireAuth, async (req: AuthRequest, res) => {
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
        console.log(`[Clone] Duplicating: ${sourcePlaylist.name} (${originalPlaylistIdStr}). Original Source IDs: ${newSourceIds.join(', ')}`);

        // 0. Optionally create a new source if new credentials are provided
        if (sourceUsername && sourcePassword && sourcePlaylist.sourceIds.length > 0) {
          console.log(`[Clone] Creating new source override for: ${sourceUsername}`);
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
            console.log(`[Clone] Source cloned successfully: ${newSourceIds[0]}`);
            
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
              console.error(`[Clone] Background refresh failed for new source ${sourceResult.insertedId}:`, err);
            });
          } else {
            console.warn(`[Clone] WARNING: Original source ${originalSourceId} not found in DB.`);
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
          console.log(`[Clone] Found ${catMappings.length} category mappings to duplicate.`);
          const newCatMappings = catMappings.map(m => {
            const newM = { ...m, _id: undefined, playlistId: newPlaylistId };
            delete (newM as any)._id;
            return newM;
          });
          await db.collection('categoryMappings').insertMany(newCatMappings);
        } else {
          console.log(`[Clone] No category mappings found for source ${originalPlaylistIdStr}`);
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
          console.log(`[Clone] Found ${streamMappings.length} stream mappings to duplicate.`);
          
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
          console.log(`[Clone] Stream mappings duplicated successfully.`);
        } else {
          console.warn(`[Clone] No stream mappings found for source playlist ${originalPlaylistIdStr}`);
        }

        console.log(`[Clone] Success: Playlist duplicated to ${newPlaylistId}`);
        res.json({ id: newPlaylistId });
      } catch (err: any) {
        log(`Error cloning playlist ${playlistId}: ${err.message}`);
        res.status(500).json({ error: "Failed to clone playlist" });
      }
    });

    app.get("/api/playlists", requireAuth, async (req: AuthRequest, res) => {
      const db = getDb();
      const docs = await db.collection('playlists').find({ userId: req.user!.id }).toArray();
      res.json(docsWithId(docs));
    });

    app.post("/api/playlists", requireAuth, async (req: AuthRequest, res) => {
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
      };
      const result = await db.collection('playlists').insertOne(playlist);
      res.status(201).json({ id: result.insertedId.toString(), ...playlist });
    });

    app.put("/api/playlists/:id", requireAuth, async (req: AuthRequest, res) => {
      const db = getDb();
      const { id, ...update } = req.body;

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
      res.json({ success: true });
    });

    app.delete("/api/playlists/:id", requireAuth, async (req: AuthRequest, res) => {
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
    // Global playlist search
    // =====================================
    app.get("/api/playlists/:id/search", requireAuth, async (req: AuthRequest, res) => {
      const { q } = req.query;
      if (!q || typeof q !== 'string' || q.trim().length < 2) {
        return res.status(400).json({ error: 'q must be at least 2 characters' });
      }

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
        const sourceId = sourceDoc.id ?? sourceDoc._id.toString();

        // Category name lookup from cache
        const catCache = getCached(`${sourceId}_categories`);
        const catMap = new Map<string, string>();
        if (catCache?.data) {
          for (const cat of catCache.data as any[]) {
            catMap.set(String(cat.category_id), cat.category_name || '');
          }
        }

        for (const type of ['live', 'vod', 'series'] as const) {
          let cached = getCached(`${sourceId}_streams_${type}`);

          // Fetch from upstream if cache is cold
          if (!cached) {
            try {
              const client = new XtreamClient(sourceDoc as any);
              let streams;
              if (type === 'live') streams = await client.getLiveStreams();
              else if (type === 'vod') streams = await client.getVodStreams();
              else streams = await client.getSeries();
              setCache(`${sourceId}_streams_${type}`, streams);
              cached = getCached(`${sourceId}_streams_${type}`);
            } catch {
              continue;
            }
          }

          if (!cached?.data) continue;

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
    });

    // =====================================
    // Settings
    // =====================================
    app.get("/api/settings", requireAuth, async (_req, res) => {
      const db = getDb();
      const doc = await db.collection('settings').findOne({ _id: 'global' as any });
      res.json({
        qualityLabelFormat: doc?.qualityLabelFormat ?? '{surround::exists["[{surround}] "||""]}{hdr::exists["[{hdr}] "||""]}[{label}]',
      });
    });

    app.patch("/api/settings", requireAuth, async (req: AuthRequest, res) => {
      if ((req as AuthRequest).user?.role !== 'admin') {
        return res.status(403).json({ error: 'Admin only' });
      }
      const db = getDb();
      const { qualityLabelFormat } = req.body;
      if (typeof qualityLabelFormat !== 'string' || qualityLabelFormat.length > 200) {
        return res.status(400).json({ error: 'qualityLabelFormat must be a string ≤ 200 characters' });
      }
      await db.collection('settings').updateOne(
        { _id: 'global' as any },
        { $set: { qualityLabelFormat } },
        { upsert: true }
      );
      _qualityFormatCache = null;
      res.json({ success: true });
    });

    // =====================================
    // Quality Scan
    // =====================================
    app.post("/api/quality-scan", requireAuth, async (req: AuthRequest, res) => {
      const { playlistId, streamIds, type, concurrency = 1 } = req.body as {
        playlistId: string;
        streamIds: string[];
        type: 'live' | 'vod' | 'series';
        concurrency?: number;
      };

      if (!playlistId || !Array.isArray(streamIds) || !streamIds.length || !type) {
        return res.status(400).json({ error: 'playlistId, streamIds, and type are required' });
      }

      if (streamIds.length > 500) {
        return res.status(400).json({ error: 'Maximum 500 streams per scan job' });
      }

      if (!streamIds.every((id: any) => typeof id === 'string' && id.length > 0)) {
        return res.status(400).json({ error: 'streamIds must be an array of non-empty strings' });
      }

      if (!['live', 'vod', 'series'].includes(type)) {
        return res.status(400).json({ error: 'type must be live, vod, or series' });
      }

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
      if (!validSources.length) return res.status(400).json({ error: 'No sources found for playlist' });

      const jobId = Math.random().toString(36).slice(2);
      const job: ScanJob = {
        id: jobId,
        userId: req.user!.id,
        status: 'running',
        total: streamIds.length,
        done: 0,
        failed: 0,
        results: [],
      };
      scanJobs.set(jobId, job);
      res.json({ jobId });

      // Run in background — do not await
      (async () => {
        const cap = Math.max(1, Math.min(5, concurrency));

        for (let i = 0; i < streamIds.length; i += cap) {
          if (job.status === 'cancelled') break;
          const batch = streamIds.slice(i, i + cap);

          await Promise.all(batch.map(async (streamId) => {
            if (job.status === 'cancelled') return;

            let meta: any = null;
            let lastError = '';

            // Try each source until one works
            for (const sourceDoc of validSources) {
              try {
                // For VOD/series, use the real container_extension from the stream cache
                // (defaults to 'mp4' only when cache is cold — most providers ignore the extension anyway)
                let extension: string | undefined;
                if (type === 'vod' || type === 'series') {
                  const cached = getCached(`${sourceDoc.id ?? sourceDoc._id.toString()}_streams_${type}`);
                  if (cached?.data) {
                    const streamData = (cached.data as any[]).find(
                      (s: any) => String(s.stream_id ?? s.series_id) === streamId
                    );
                    extension = streamData?.container_extension || undefined;
                  }
                }
                const url = buildStreamUrl(sourceDoc, streamId, type, extension);
                meta = await probeStream(url);
                break;
              } catch (e: any) {
                lastError = e.message;
              }
            }

            if (meta) {
              meta.scannedAt = new Date().toISOString();
              // Upsert detectedMeta — create a minimal mapping if none exists yet
              await db.collection('mappings').updateOne(
                { playlistId, originalId: streamId, type },
                {
                  $set: { detectedMeta: meta },
                  $setOnInsert: { originalName: '', customName: '', hidden: false, order: 0, categoryId: '' },
                },
                { upsert: true }
              );
              job.results.push({ streamId, meta });
            } else {
              job.results.push({ streamId, error: lastError || 'All sources failed' });
              job.failed++;
            }
            job.done++;
          }));
        }

        if (job.status !== 'cancelled') job.status = 'done';
        // Auto-clean job after 10 minutes
        setTimeout(() => scanJobs.delete(jobId), 10 * 60 * 1000);
      })().catch((e) => {
        log(`[QualityScan] Job ${jobId} crashed: ${e.message}`);
        job.status = 'done';
      });
    });

    app.get("/api/quality-scan/:jobId", requireAuth, (req, res) => {
      const job = scanJobs.get(req.params.jobId);
      if (!job || job.userId !== (req as AuthRequest).user!.id)
        return res.status(404).json({ error: 'Job not found' });
      res.json(job);
    });

    app.delete("/api/quality-scan/:jobId", requireAuth, (req, res) => {
      const job = scanJobs.get(req.params.jobId);
      if (!job || job.userId !== (req as AuthRequest).user!.id)
        return res.status(404).json({ error: 'Job not found' });
      job.status = 'cancelled';
      res.json({ success: true });
    });

    // =====================================
    // VOD / Series download proxy
    // =====================================
    app.get("/api/download/:type/:playlistId/:streamId", requireAuthOrQuery, async (req: AuthRequest, res) => {
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

    // =====================================
    // CRUD: Mappings
    // =====================================
    app.get("/api/mappings", requireAuth, async (req: AuthRequest, res) => {
      const { playlistId } = req.query;
      if (!playlistId) return res.status(400).json({ error: "playlistId required" });
      const db = getDb();
      const docs = await db.collection('mappings').find({ playlistId: playlistId as string }).toArray();
      res.json(docsWithId(docs));
    });

    app.post("/api/mappings", requireAuth, async (req: AuthRequest, res) => {
      const db = getDb();
      const result = await db.collection('mappings').insertOne(req.body);
      res.status(201).json({ id: result.insertedId.toString(), ...req.body });
    });

    app.put("/api/mappings/:id", requireAuth, async (req: AuthRequest, res) => {
      const db = getDb();
      const { id, ...update } = req.body;
      await db.collection('mappings').updateOne({ _id: toId(req.params.id) }, { $set: update });
      res.json({ success: true });
    });

    app.post("/api/mappings/batch", requireAuth, async (req: AuthRequest, res) => {
      const db = getDb();
      const { updates } = req.body; // Array of { id?, originalId, playlistId, type, ...data }
      
      const ops = updates.map((update: any) => {
        const { id, ...data } = update;
        if (id) {
          return {
            updateOne: {
              filter: { _id: toId(id) },
              update: { $set: data }
            }
          };
        } else {
          return {
            updateOne: {
              filter: { originalId: data.originalId, playlistId: data.playlistId, type: data.type },
              update: { $set: data },
              upsert: true
            }
          };
        }
      });

      if (ops.length > 0) {
        await db.collection('mappings').bulkWrite(ops);
      }
      res.json({ success: true, count: ops.length });
    });

    app.delete("/api/mappings/:id", requireAuth, async (req: AuthRequest, res) => {
      const db = getDb();
      await db.collection('mappings').deleteOne({ _id: toId(req.params.id) });
      res.json({ success: true });
    });

    // =====================================
    // CRUD: Category Mappings
    // =====================================
    app.get("/api/category-mappings", requireAuth, async (req: AuthRequest, res) => {
      const { playlistId } = req.query;
      if (!playlistId) return res.status(400).json({ error: "playlistId required" });
      const db = getDb();
      const docs = await db.collection('categoryMappings').find({ playlistId: playlistId as string }).toArray();
      res.json(docsWithId(docs));
    });

    app.post("/api/category-mappings", requireAuth, async (req: AuthRequest, res) => {
      const db = getDb();
      const result = await db.collection('categoryMappings').insertOne(req.body);
      res.status(201).json({ id: result.insertedId.toString(), ...req.body });
    });

    app.put("/api/category-mappings/:id", requireAuth, async (req: AuthRequest, res) => {
      const db = getDb();
      const { id, ...update } = req.body;
      await db.collection('categoryMappings').updateOne({ _id: toId(req.params.id) }, { $set: update });
      res.json({ success: true });
    });

    app.post("/api/category-mappings/batch", requireAuth, async (req: AuthRequest, res) => {
      const db = getDb();
      const { updates } = req.body;
      
      const ops = updates.map((update: any) => {
        const { id, ...data } = update;
        if (id) {
          return {
            updateOne: {
              filter: { _id: toId(id) },
              update: { $set: data }
            }
          };
        } else {
          return {
            updateOne: {
              filter: { originalId: data.originalId, playlistId: data.playlistId, type: data.type },
              update: { $set: data },
              upsert: true
            }
          };
        }
      });

      if (ops.length > 0) {
        await db.collection('categoryMappings').bulkWrite(ops);
      }
      res.json({ success: true, count: ops.length });
    });

    app.delete("/api/category-mappings/:id", requireAuth, async (req: AuthRequest, res) => {
      const db = getDb();
      await db.collection('categoryMappings').deleteOne({ _id: toId(req.params.id) });
      res.json({ success: true });
    });

    // =====================================
    // Upstream data fetch (with disk cache)
    // =====================================
    app.post("/api/fetch-upstream", requireAuth, async (req, res) => {
      const { source, forceRefresh } = req.body;
      if (!source?.id) return res.status(400).json({ error: "Missing source ID" });

      log(`Fetching categories for source ${source.name} (id: ${source.id}, forceRefresh: ${forceRefresh})`);
      const cacheKey = `${source.id}_categories`;

      if (!forceRefresh) {
        const cached = getCached(cacheKey);
        if (cached) {
          log(`  Cache hit for categories: ${source.id}`);
          return res.json({ ...cached.data, cached: true, lastUpdated: cached.lastUpdated });
        }
      }

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
          
          const data = { liveCats, vodCats, seriesCats };
          setCache(cacheKey, data);
          res.json({ ...data, cached: false, lastUpdated: new Date().toISOString() });
        } catch (error: any) {
          log(`  ERROR fetching categories for ${source.id}: ${error.message}`);
          if (error.response) {
            log(`    Status: ${error.response.status}`);
            log(`    Data: ${JSON.stringify(error.response.data)}`);
          }
          res.status(500).json({ error: "Failed to fetch categories: " + error.message });
        }
      } else {
        res.status(400).json({ error: `Source type '${source.type}' does not support category fetching via Xtream API` });
      }
    });

    app.post("/api/fetch-streams", requireAuth, async (req, res) => {
      const { source, type, forceRefresh } = req.body;
      if (!source?.id || !type) return res.status(400).json({ error: "Missing source ID or type" });

      log(`Fetching streams [${type}] for source ${source.name} (id: ${source.id}, forceRefresh: ${forceRefresh})`);
      const cacheKey = `${source.id}_streams_${type}`;

      if (!forceRefresh) {
        const cached = getCached(cacheKey);
        if (cached) {
          log(`  Cache hit for streams [${type}]: ${source.id}`);
          return res.json({ streams: cached.data, cached: true, lastUpdated: cached.lastUpdated });
        }
      }

      log(`  Cache miss for streams [${type}]: ${source.id}. Fetching from ${source.url}`);

      const client = new XtreamClient(source);
      try {
        let streams;
        log(`  Requesting streams [${type}] from Xtream API...`);
        if (type === 'live') streams = await client.getLiveStreams();
        else if (type === 'vod') streams = await client.getVodStreams();
        else if (type === 'series') streams = await client.getSeries();

        log(`  Successfully fetched ${streams?.length || 0} streams`);
        
        setCache(cacheKey, streams);
        res.json({ streams, cached: false, lastUpdated: new Date().toISOString() });
      } catch (error: any) {
        log(`  ERROR fetching streams [${type}] for ${source.id}: ${error.message}`);
        if (error.response) {
          log(`    Status: ${error.response.status}`);
          log(`    Data: ${JSON.stringify(error.response.data)}`);
        }
        res.status(500).json({ error: "Failed to fetch streams: " + error.message });
      }
    });

    // =====================================
    // Xtream Codes Proxy API (public, authenticated by playlist credentials)
    // =====================================
    const findPlaylistByCredentials = async (username: string, password: string) => {
      const db = getDb();
      const doc = await db.collection('playlists').findOne({ username, password });
      return doc ? docWithId(doc) : null;
    };

    // Proxy Stats Tracking
    const proxyStats = {
      activeStreams: 0,
      totalBytes: 0,
      currentBps: 0,
      lastCheck: Date.now(),
      intervalBytes: 0,
      history: [] as { time: number; bps: number }[],
      connections: new Map<string, {
        id: string;
        username: string;
        streamId: string;
        streamName: string;
        playlistName: string;
        type: string;
        ip: string;
        startTime: number;
        bytesRead: number;
        intervalBytes: number;
        currentBps: number;
        proxied: boolean;
      }>()
    };

    // Update bits per second regularly and keep a history
    setInterval(() => {
      const now = Date.now();
      const elapsed = (now - proxyStats.lastCheck) / 1000;
      if (elapsed > 0) {
        proxyStats.currentBps = (proxyStats.intervalBytes * 8) / elapsed;
        proxyStats.intervalBytes = 0;
        proxyStats.lastCheck = now;

        // Update per-connection bandwidth
        for (const conn of proxyStats.connections.values()) {
          conn.currentBps = (conn.intervalBytes * 8) / elapsed;
          conn.intervalBytes = 0;
        }

        // Keep 60 points of history (2 minutes at 2s intervals)
        proxyStats.history.push({ time: now, bps: proxyStats.currentBps });
        if (proxyStats.history.length > 60) proxyStats.history.shift();
      }
    }, 2000);

    // Proxy handling helper
    const handleStreamProxy = async (req: express.Request, res: express.Response, type: 'live' | 'movie' | 'series') => {
      const { username, password, streamId, ext } = req.params;
      
      const playlist = await findPlaylistByCredentials(username, password) as Playlist | null;
      if (!playlist) return res.status(403).send("Invalid credentials");

      const db = getDb();
      const sourceIds: string[] = playlist.sourceIds || [];
      if (!sourceIds.length) return res.status(400).send("No source configured");

      const globalFormat = await getGlobalQualityFormat();

      // Look up stream name from mappings (customName takes priority over originalName)
      const mappingTypeMap: Record<string, string> = { live: 'live', movie: 'vod', series: 'series' };
      const streamMapping = await db.collection('mappings').findOne({
        playlistId: String(playlist.id),
        originalId: streamId,
        type: mappingTypeMap[type],
      });
      const streamName = streamMapping
        ? computeDisplayName(streamMapping as any, playlist.qualityLabelFormat, globalFormat)
        : `Stream ${streamId}`;

      const upstreamHeaders: Record<string, string> = {
        'User-Agent': (req.headers['user-agent'] as string) || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) IPTV-Proxy/1.0',
      };
      if (req.headers['range']) upstreamHeaders['Range'] = req.headers['range'] as string;

      // Try each source in order, fall back to the next on failure
      let lastError = '';
      for (const sourceId of sourceIds) {
        const sourceDoc = await db.collection('sources').findOne({ _id: toId(sourceId) });
        if (!sourceDoc) continue;

        const upstreamUrl = ext
          ? `${sourceDoc.url}/${type}/${sourceDoc.username}/${sourceDoc.password}/${streamId}.${ext}`
          : `${sourceDoc.url}/${type}/${sourceDoc.username}/${sourceDoc.password}/${streamId}`;

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
            log(`[Proxy] Source ${sourceId} failed (${response.status}) for ${type}/${streamId}, trying next...`);
            continue;
          }

          log(`[Proxy] ${type}/${streamId} for ${username} via source ${sourceId}`);

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
          log(`[Proxy] Source ${sourceId} error for ${type}/${streamId}: ${err.message}, trying next...`);
        }
      }

      log(`[Proxy] All sources failed for ${type}/${streamId}: ${lastError}`);
      res.status(502).send("All upstream sources failed");
    };

    // Stream proxy routes — all traffic flows through this server (required for VPN routing)
    // Extension routes must be registered before extensionless so Express matches them first
    app.get("/live/:username/:password/:streamId.:ext", (req, res) => handleStreamProxy(req, res, 'live'));
    app.get("/movie/:username/:password/:streamId.:ext", (req, res) => handleStreamProxy(req, res, 'movie'));
    app.get("/series/:username/:password/:streamId.:ext", (req, res) => handleStreamProxy(req, res, 'series'));
    app.get("/live/:username/:password/:streamId", (req, res) => handleStreamProxy(req, res, 'live'));
    app.get("/movie/:username/:password/:streamId", (req, res) => handleStreamProxy(req, res, 'movie'));
    app.get("/series/:username/:password/:streamId", (req, res) => handleStreamProxy(req, res, 'series'));

    // Timeshift proxy — /timeshift/{username}/{password}/{duration}/{start}/{streamId}.{ext}
    app.get("/timeshift/:username/:password/:duration/:start/:streamId.:ext", async (req, res) => {
      const { username, password, duration, start, streamId, ext } = req.params;

      const playlist = await findPlaylistByCredentials(username, password) as Playlist | null;
      if (!playlist) return res.status(403).send("Invalid credentials");

      const db = getDb();
      const sourceId = playlist.sourceIds?.[0];
      if (!sourceId) return res.status(400).send("No source configured");

      const sourceDoc = await db.collection('sources').findOne({ _id: toId(sourceId) });
      if (!sourceDoc) return res.status(404).send("Source not found");

      const upstreamUrl = `${sourceDoc.url}/timeshift/${sourceDoc.username}/${sourceDoc.password}/${duration}/${start}/${streamId}.${ext}`;
      log(`[Timeshift] ${username} -> ${streamId} start=${start} dur=${duration}m`);

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
        log(`[Timeshift] Error: ${err.message}`);
        res.status(502).send("Upstream timeshift error");
      }
    });


    app.get("/player_api.php", async (req, res) => {
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
      const [mappingDocs, catMappingDocs] = await Promise.all([
        db.collection('mappings').find({ playlistId: playlist.id }).toArray(),
        db.collection('categoryMappings').find({ playlistId: playlist.id }).toArray(),
      ]);
      const mappings = docsWithId(mappingDocs) as StreamMapping[];
      const catMappings = docsWithId(catMappingDocs) as CategoryMapping[];
      const globalFormat = await getGlobalQualityFormat();

      const sourceId = playlist.sourceIds?.[0];
      if (!sourceId) {
        return res.json({ status: "error", message: "No source configured for this playlist" });
      }

      const sourceDoc = await db.collection('sources').findOne({ _id: toId(sourceId) });
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
          const protocol = (req.headers['x-forwarded-proto'] || req.protocol || 'http').toString();
          const hostHeader = (req.headers['x-forwarded-host'] || req.get('host') || `localhost:${PORT}`).toString();
          const appUrl = process.env.APP_URL && !process.env.APP_URL.includes('YOUR_LAN_IP')
            ? process.env.APP_URL
            : null;

          if (appUrl) {
            const parsed = new URL(appUrl);
            // url must be scheme+host only — no trailing slash, no port (port is a separate field)
            auth.server_info.url = `${parsed.protocol}//${parsed.hostname}`;
            auth.server_info.port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
            auth.server_info.https_port = parsed.protocol === 'https:' ? (parsed.port || '443') : '443';
            auth.server_info.server_protocol = parsed.protocol.replace(':', '');
          } else {
            const hostname = hostHeader.split(':')[0];
            const port = hostHeader.split(':')[1] || (protocol === 'https' ? '443' : '80');
            auth.server_info.url = `${protocol}://${hostname}`;
            auth.server_info.port = port;
            auth.server_info.https_port = protocol === 'https' ? port : "443";
            auth.server_info.server_protocol = protocol;
          }
        }
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        return res.json(auth);
      }

      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');

      // Check if this action requires On-Demand Sync (Dynamic Sync)
      // If categories in this playlist have syncOnDemand, we refresh the source for that type
      const hasSyncOnDemandLive = catMappings.some(m => m.type === 'live' && m.syncOnDemand);
      const hasSyncOnDemandVod = catMappings.some(m => m.type === 'vod' && m.syncOnDemand);
      const hasSyncOnDemandSeries = catMappings.some(m => m.type === 'series' && m.syncOnDemand);

      if (action === 'get_live_streams' && hasSyncOnDemandLive) await refreshSource(sourceId, 'live');
      if (action === 'get_vod_streams' && hasSyncOnDemandVod) await refreshSource(sourceId, 'vod');
      if (action === 'get_series' && hasSyncOnDemandSeries) await refreshSource(sourceId, 'series');

      try {
        let data;
        switch (action) {
          case 'get_live_categories': {
            const allResults = await Promise.all(playlist.sourceIds.map(async (sid: string) => {
              const sDoc = await db.collection('sources').findOne({ _id: toId(sid) });
              if (!sDoc) return [];
              const cl = new XtreamClient(sDoc as any);
              return cl.getLiveCategories().catch(() => []);
            }));
            data = allResults.flat().filter((c: any, i: number, a: any[]) => {
              const cid = String(c.category_id || c.id);
              return a.findIndex(cc => String(cc.category_id || cc.id) === cid) === i;
            });
            
            const catMap = new Map(catMappings.filter(m => m.type === 'live').map(m => [String(m.originalId), m]));
            
            data.forEach((c: any, idx: number) => {
              const cid = String(c.category_id || c.id);
              const mapping = catMap.get(cid);
              c._order = mapping?.order ?? (999999 + idx);
              if (mapping?.customName) c.category_name = mapping.customName;
              c._hidden = mapping?.hidden || false;
            });
            data = data.filter((c: any) => !c._hidden).sort((a: any, b: any) => a._order - b._order);
            data.forEach((c: any) => { delete c._order; delete c._hidden; });
            break;
          }
          case 'get_live_streams': {
            const categoryId = req.query.category_id as string;
            const allResults = await Promise.all(playlist.sourceIds.map(async (sid: string) => {
              const sDoc = await db.collection('sources').findOne({ _id: toId(sid) });
              if (!sDoc) return [];
              const cl = new XtreamClient(sDoc as any);
              const streams = await cl.getLiveStreams().catch(() => []);
              return streams.map((s: any) => ({ ...s, _client: cl }));
            }));
            data = allResults.flat();
            
            const catMap = new Map(catMappings.filter(m => m.type === 'live').map(m => [String(m.originalId), m]));
            const mappingMap = new Map(mappings.filter(m => m.type === 'live').map(m => [String(m.originalId), m]));

            // Build category order map for grouping
            const catOrderMap = new Map();
            const allCatsResults = await Promise.all(playlist.sourceIds.map(async (sid: string) => {
              const sDoc = await db.collection('sources').findOne({ _id: toId(sid) });
              if (!sDoc) return [];
              const cl = new XtreamClient(sDoc as any);
              return cl.getLiveCategories().catch(() => []);
            }));
            const deduplicatedCats = allCatsResults.flat().filter((c: any, i: number, a: any[]) => {
                const cid = String(c.category_id || c.id);
                return a.findIndex(cc => String(cc.category_id || cc.id) === cid) === i;
            });
            deduplicatedCats.forEach((c: any, idx: number) => {
                const cid = String(c.category_id || c.id);
                const mapping = catMap.get(cid);
                catOrderMap.set(cid, mapping?.order ?? (999999 + idx));
            });

            data = data.filter((s: any, idx: number) => {
              const sid = String(s.stream_id);
              const mapping = mappingMap.get(sid);
              if (mapping?.hidden) return false;
              
              if (mapping?.categoryId && mapping.categoryId !== String(s.category_id)) {
                s.category_id = mapping.categoryId;
              }
              
              if (categoryId && String(s.category_id) !== categoryId) return false;
              
              const catMapping = catMap.get(String(s.category_id));
              if (catMapping?.hidden) return false;
              
              if (mapping) s.name = applyRegex(computeDisplayName(mapping, playlist.qualityLabelFormat, globalFormat), mapping.regexRenames || []);
              // Icon priority: customIcon > epgIcon (from EPG source) > upstream icon
              const resolvedIcon = mapping?.customIcon || mapping?.epgIcon || null;
              if (resolvedIcon) s.stream_icon = resolvedIcon;
              if (mapping?.epgMapping) s.epg_channel_id = mapping.epgMapping;
              
              if (playlist.directStreams && s._client) {
                s.direct_source = s._client.getLiveStreamUrl(s.stream_id);
              }
              
              s._catOrder = catOrderMap.get(String(s.category_id)) ?? 1999999;
              s._streamOrder = mapping?.order ?? (999999 + idx);
              return true;
            }).sort((a: any, b: any) => {
              if (a._catOrder !== b._catOrder) return a._catOrder - b._catOrder;
              return a._streamOrder - b._streamOrder;
            });
            data.forEach((s: any) => { delete s._catOrder; delete s._streamOrder; delete s._client; });
            break;
          }
          case 'get_vod_categories': {
            const allResults = await Promise.all(playlist.sourceIds.map(async (sid: string) => {
              const sDoc = await db.collection('sources').findOne({ _id: toId(sid) });
              if (!sDoc) return [];
              const cl = new XtreamClient(sDoc as any);
              return cl.getVodCategories().catch(() => []);
            }));
            data = allResults.flat().filter((c: any, i: number, a: any[]) => {
              const cid = String(c.category_id || c.id);
              return a.findIndex(cc => String(cc.category_id || cc.id) === cid) === i;
            });
            data.forEach((c: any, idx: number) => {
              const cid = String(c.category_id || c.id);
              const mapping = catMappings.find(m => m.type === 'vod' && m.originalId === cid);
              c._order = mapping?.order ?? (999999 + idx);
              if (mapping?.customName) c.category_name = mapping.customName;
              c._hidden = mapping?.hidden || false;
            });
            data = data.filter((c: any) => !c._hidden).sort((a: any, b: any) => a._order - b._order);
            data.forEach((c: any) => { delete c._order; delete c._hidden; });
            break;
          }
          case 'get_vod_streams': {
            const categoryId = req.query.category_id as string;
            const allResults = await Promise.all(playlist.sourceIds.map(async (sid: string) => {
              const sDoc = await db.collection('sources').findOne({ _id: toId(sid) });
              if (!sDoc) return [];
              const cl = new XtreamClient(sDoc as any);
              return cl.getVodStreams().catch(() => []);
            }));
            data = allResults.flat();

            const catMap = new Map(catMappings.filter(m => m.type === 'vod').map(m => [String(m.originalId), m]));
            const mappingMap = new Map(mappings.filter(m => m.type === 'vod').map(m => [String(m.originalId), m]));

            const catOrderMap = new Map();
            const allCatsResults = await Promise.all(playlist.sourceIds.map(async (sid: string) => {
              const sDoc = await db.collection('sources').findOne({ _id: toId(sid) });
              if (!sDoc) return [];
              const cl = new XtreamClient(sDoc as any);
              return cl.getVodCategories().catch(() => []);
            }));
            const deduplicatedCats = allCatsResults.flat().filter((c: any, i: number, a: any[]) => {
                const cid = String(c.category_id || c.id);
                return a.findIndex(cc => String(cc.category_id || cc.id) === cid) === i;
            });
            deduplicatedCats.forEach((c: any, idx: number) => {
                const cid = String(c.category_id || c.id);
                const mapping = catMap.get(cid);
                catOrderMap.set(cid, mapping?.order ?? (999999 + idx));
            });

            data = data.filter((s: any, idx: number) => {
              const sid = String(s.stream_id);
              const mapping = mappingMap.get(sid);
              if (mapping?.hidden) return false;
              if (mapping?.categoryId && mapping.categoryId !== String(s.category_id)) {
                s.category_id = mapping.categoryId;
              }
              if (categoryId && String(s.category_id) !== categoryId) return false;
              const catMapping = catMap.get(String(s.category_id));
              if (catMapping?.hidden) return false;
              if (mapping) s.name = applyRegex(computeDisplayName(mapping, playlist.qualityLabelFormat, globalFormat), mapping.regexRenames || []);
              s._catOrder = catOrderMap.get(String(s.category_id)) ?? 1999999;
              s._streamOrder = mapping?.order ?? (999999 + idx);
              return true;
            }).sort((a: any, b: any) => {
              if (a._catOrder !== b._catOrder) return a._catOrder - b._catOrder;
              return a._streamOrder - b._streamOrder;
            });
            data.forEach((s: any) => { delete s._catOrder; delete s._streamOrder; });
            break;
          }
          case 'get_series_categories': {
            const allResults = await Promise.all(playlist.sourceIds.map(async (sid: string) => {
              const sDoc = await db.collection('sources').findOne({ _id: toId(sid) });
              if (!sDoc) return [];
              const cl = new XtreamClient(sDoc as any);
              return cl.getSeriesCategories().catch(() => []);
            }));
            data = allResults.flat().filter((c: any, i: number, a: any[]) => {
              const cid = String(c.category_id || c.id);
              return a.findIndex(cc => String(cc.category_id || cc.id) === cid) === i;
            });
            data.forEach((c: any, idx: number) => {
              const cid = String(c.category_id || c.id);
              const mapping = catMappings.find(m => m.type === 'series' && m.originalId === cid);
              c._order = mapping?.order ?? (999999 + idx);
              if (mapping?.customName) c.category_name = mapping.customName;
              c._hidden = mapping?.hidden || false;
            });
            data = data.filter((c: any) => !c._hidden).sort((a: any, b: any) => a._order - b._order);
            data.forEach((c: any) => { delete c._order; delete c._hidden; });
            break;
          }
          case 'get_series': {
            const categoryId = req.query.category_id as string;
            const allResults = await Promise.all(playlist.sourceIds.map(async (sid: string) => {
              const sDoc = await db.collection('sources').findOne({ _id: toId(sid) });
              if (!sDoc) return [];
              const cl = new XtreamClient(sDoc as any);
              return cl.getSeries().catch(() => []);
            }));
            data = allResults.flat();

            const catMap = new Map(catMappings.filter(m => m.type === 'series').map(m => [String(m.originalId), m]));
            const mappingMap = new Map(mappings.filter(m => m.type === 'series').map(m => [String(m.originalId), m]));

            const catOrderMap = new Map();
            const allCatsResults = await Promise.all(playlist.sourceIds.map(async (sid: string) => {
              const sDoc = await db.collection('sources').findOne({ _id: toId(sid) });
              if (!sDoc) return [];
              const cl = new XtreamClient(sDoc as any);
              return cl.getSeriesCategories().catch(() => []);
            }));
            const deduplicatedCats = allCatsResults.flat().filter((c: any, i: number, a: any[]) => {
                const cid = String(c.category_id || c.id);
                return a.findIndex(cc => String(cc.category_id || cc.id) === cid) === i;
            });
            deduplicatedCats.forEach((c: any, idx: number) => {
                const cid = String(c.category_id || c.id);
                const mapping = catMap.get(cid);
                catOrderMap.set(cid, mapping?.order ?? (999999 + idx));
            });

            data = data.filter((s: any, idx: number) => {
              const sid = String(s.series_id);
              const mapping = mappingMap.get(sid);
              if (mapping?.hidden) return false;
              if (mapping?.categoryId && mapping.categoryId !== String(s.category_id)) {
                s.category_id = mapping.categoryId;
              }
              if (categoryId && String(s.category_id) !== categoryId) return false;
              const catMapping = catMap.get(String(s.category_id));
              if (catMapping?.hidden) return false;
              if (mapping) s.name = applyRegex(computeDisplayName(mapping, playlist.qualityLabelFormat, globalFormat), mapping.regexRenames || []);
              s._catOrder = catOrderMap.get(String(s.category_id)) ?? 1999999;
              s._streamOrder = mapping?.order ?? (999999 + idx);
              return true;
            }).sort((a: any, b: any) => {
              if (a._catOrder !== b._catOrder) return a._catOrder - b._catOrder;
              return a._streamOrder - b._streamOrder;
            });
            data.forEach((s: any) => { delete s._catOrder; delete s._streamOrder; });
            break;
          }
          case 'get_live_info': {
            const liveStreamId = req.query.stream_id as string;
            const liveResults = await Promise.all(playlist.sourceIds.map(async (sid: string) => {
              const sDoc = await db.collection('sources').findOne({ _id: toId(sid) });
              if (!sDoc) return null;
              const cl = new XtreamClient(sDoc as any);
              try { return await cl.getLiveInfo(liveStreamId); } catch { return null; }
            }));
            data = liveResults.find(r => r !== null) || {};
            break;
          }

          case 'get_short_epg': {
            const epgStreamId = req.query.stream_id as string;
            const epgLimit = req.query.limit ? parseInt(req.query.limit as string) : undefined;
            const epgResults = await Promise.all(playlist.sourceIds.map(async (sid: string) => {
              const sDoc = await db.collection('sources').findOne({ _id: toId(sid) });
              if (!sDoc) return null;
              const cl = new XtreamClient(sDoc as any);
              try {
                const r = await cl.getShortEpg(epgStreamId, epgLimit);
                if (r && (r.epg_listings?.length || r.length)) return r;
              } catch { return null; }
              return null;
            }));
            data = epgResults.find(r => r !== null) || { epg_listings: [] };
            break;
          }

          case 'get_simple_data_table': {
            const tableStreamId = req.query.stream_id as string;
            const tableResults = await Promise.all(playlist.sourceIds.map(async (sid: string) => {
              const sDoc = await db.collection('sources').findOne({ _id: toId(sid) });
              if (!sDoc) return null;
              const cl = new XtreamClient(sDoc as any);
              try {
                const r = await cl.getSimpleDataTable(tableStreamId);
                if (r && (r.epg_listings?.length || r.length)) return r;
              } catch { return null; }
              return null;
            }));
            data = tableResults.find(r => r !== null) || { epg_listings: [] };
            break;
          }

          case 'get_vod_info': {
            const vodId = req.query.vod_id as string;
            const allVodResults = await Promise.all(playlist.sourceIds.map(async (sid: string) => {
              const sDoc = await db.collection('sources').findOne({ _id: toId(sid) });
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
            break;
          }

          case 'get_series_info': {
            const seriesId = req.query.series_id as string;
            const allSourceResults = await Promise.all(playlist.sourceIds.map(async (sid: string) => {
              const sDoc = await db.collection('sources').findOne({ _id: toId(sid) });
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
    app.get("/get.php", async (req, res) => {
      const { username, password, u, p, type } = req.query;
      
      // Support both full parameter names and Xtream API shortened names
      const actualUsername = username || u;
      const actualPassword = password || p;
      
      if (!actualUsername || !actualPassword) return res.status(400).send("Missing credentials");

      const playlist = await findPlaylistByCredentials(actualUsername as string, actualPassword as string) as Playlist | null;
      if (!playlist) return res.status(401).send("Invalid credentials");

      const db = getDb();
      const [mappingDocs, catMappingDocs] = await Promise.all([
        db.collection('mappings').find({ playlistId: playlist.id }).toArray(),
        db.collection('categoryMappings').find({ playlistId: playlist.id }).toArray(),
      ]);
      const mappings = docsWithId(mappingDocs) as StreamMapping[];
      const catMappings = docsWithId(catMappingDocs) as CategoryMapping[];
      const m3uGlobalFormat = await getGlobalQualityFormat();

      try {
        let m3u = "#EXTM3U\n";
        const m3uType = (type as string) || 'live';
        const activeTabStr = m3uType === 'vod' ? 'vod' : m3uType === 'series' ? 'series' : 'live';

        const allResults = await Promise.all(playlist.sourceIds.map(async (sid: string) => {
          const sDoc = await db.collection('sources').findOne({ _id: toId(sid) });
          if (!sDoc) return [];
          const cl = new XtreamClient(sDoc as any);
          let streams = [];
          if (m3uType === 'vod') streams = await cl.getVodStreams().catch(() => []);
          else if (m3uType === 'series') streams = await cl.getSeries().catch(() => []);
          else streams = await cl.getLiveStreams().catch(() => []);
          return streams.map((s: any) => ({ ...s, _client: cl }));
        }));
        
        let rawStreams = allResults.flat();
        
        const catMap = new Map(catMappings.filter(m => m.type === activeTabStr).map(m => [String(m.originalId), m]));
        const mappingMap = new Map(mappings.filter(m => m.type === activeTabStr).map(m => [String(m.originalId), m]));

        // Build category order map
        const catOrderMap = new Map();
        const allCatsResults = await Promise.all(playlist.sourceIds.map(async (sid: string) => {
           const sDoc = await db.collection('sources').findOne({ _id: toId(sid) });
           if (!sDoc) return [];
           const cl = new XtreamClient(sDoc as any);
           if (m3uType === 'vod') return cl.getVodCategories().catch(() => []);
           if (m3uType === 'series') return cl.getSeriesCategories().catch(() => []);
           return cl.getLiveCategories().catch(() => []);
        }));
        const deduplicatedCats = allCatsResults.flat().filter((c: any, i: number, a: any[]) => {
            const cid = String(c.category_id || c.id);
            return a.findIndex(cc => String(cc.category_id || cc.id) === cid) === i;
        });
        deduplicatedCats.forEach((c: any, idx: number) => {
            const cid = String(c.category_id || c.id);
            const mapping = catMap.get(cid);
            catOrderMap.set(cid, { 
                order: mapping?.order ?? (999999 + idx), 
                name: mapping?.customName || c.category_name,
                hidden: mapping?.hidden || false
            });
        });

        const streams = rawStreams.filter((s: any, idx: number) => {
          const sid = String(s.stream_id || s.series_id);
          const mapping = mappingMap.get(sid);
          if (mapping?.hidden) return false;
          
          if (mapping?.categoryId && mapping.categoryId !== String(s.category_id)) {
            s.category_id = mapping.categoryId;
          }
          const catInfo = catOrderMap.get(String(s.category_id));
          if (!catInfo || catInfo.hidden) return false;
          
          s._catOrder = catInfo.order;
          s._streamOrder = mapping?.order ?? (999999 + idx);
          s._displayCategoryName = catInfo.name;
          s._mapping = mapping; // Store for later use in name/logo construction
          return true;
        }).sort((a: any, b: any) => {
          if (a._catOrder !== b._catOrder) return a._catOrder - b._catOrder;
          return a._streamOrder - b._streamOrder;
        });

        // Build base URL for proxied streams
        const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
        const hostHeader = req.headers['x-forwarded-host'] || req.get('host') || `localhost:${PORT}`;
        const hostname = hostHeader.toString().split(':')[0];
        const port = hostHeader.toString().split(':')[1] || (protocol === 'https' ? '443' : '80');
        const proxyBaseUrl = process.env.APP_URL || `${protocol}://${hostname}${port && port !== '80' && port !== '443' ? `:${port}` : ''}`;

        for (const stream of streams) {
          const mapping = stream._mapping;

          const baseName = mapping
            ? computeDisplayName(mapping, playlist.qualityLabelFormat, m3uGlobalFormat)
            : (stream.name || stream.title);
          const name = mapping ? applyRegex(baseName, mapping.regexRenames || []) : baseName;
          const logo = mapping?.customIcon || mapping?.epgIcon || stream.stream_icon || stream.cover;
          const epgId = mapping?.epgMapping || stream.epg_channel_id;
          const categoryName = stream._displayCategoryName;
          const sid = String(stream.stream_id || stream.series_id);
          
          let url;
          if (playlist.directStreams && stream._client) {
            if (m3uType === 'vod') url = stream._client.getVodStreamUrl(stream.stream_id, stream.container_extension);
            else if (m3uType === 'series') url = stream._client.getSeriesStreamUrl(stream.stream_id, stream.container_extension);
            else url = stream._client.getLiveStreamUrl(stream.stream_id);
          } else {
            const pathType = m3uType === 'vod' ? 'movie' : m3uType === 'series' ? 'series' : 'live';
            url = `${proxyBaseUrl}/${pathType}/${playlist.username}/${playlist.password}/${sid}.ts`;
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
    app.get("/xmltv.php", async (req, res) => {
      const { username, password } = req.query;
      if (!username || !password) return res.status(400).send("Missing credentials");

      const playlist = await findPlaylistByCredentials(username as string, password as string) as Playlist | null;
      if (!playlist) return res.status(401).send("Invalid credentials");

      const db = getDb();

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

        // 1. Custom EPG sources linked to this playlist
        const epgIds: string[] = playlist.epgIds || [];
        if (epgIds.length) {
          const epgDocs = await db.collection('epgs').find({ _id: { $in: epgIds.map(toId) } }).toArray();
          for (const epgDoc of epgDocs) {
            if (!epgDoc.url) continue;
            const xml = await fetchXml(epgDoc.url);
            if (xml) xmlParts.push(xml);
          }
        }

        // 2. Upstream sources with useUpstreamEpg enabled
        const sourceDocs = await db.collection('sources').find({
          _id: { $in: (playlist.sourceIds || []).map(toId) },
          useUpstreamEpg: true,
        }).toArray();

        for (const sourceDoc of sourceDocs) {
          if (!sourceDoc.url || !sourceDoc.username) continue;
          const upstreamEpgUrl = `${sourceDoc.url}/xmltv.php?username=${encodeURIComponent(sourceDoc.username)}&password=${encodeURIComponent(sourceDoc.password)}`;
          log(`[EPG] Fetching upstream EPG: ${sourceDoc.url}/xmltv.php`);
          const xml = await fetchXml(upstreamEpgUrl);
          if (xml) xmlParts.push(xml);
        }

        if (!xmlParts.length) {
          return res.send('<?xml version="1.0" encoding="UTF-8"?><tv></tv>');
        }

        if (xmlParts.length === 1) {
          return res.send(xmlParts[0]);
        }

        // Merge: extract inner content from each XMLTV doc and wrap in a single <tv>
        const innerRegex = /<tv[^>]*>([\s\S]*?)<\/tv>/i;
        const inners = xmlParts.map(xml => {
          const m = innerRegex.exec(xml);
          return m ? m[1] : '';
        });
        res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n${inners.join('\n')}\n</tv>`);
      } catch (err: any) {
        log(`[EPG] Export error: ${err.message}`);
        res.status(502).send("Failed to fetch EPG data");
      }
    });

    // Auto-update cron
    cron.schedule("0 * * * *", async () => {
      log("Running auto-update...");
    });

    // Frontend serving
    const distPath = path.join(process.cwd(), "dist");
    const serveSpaFallback = () => {
      app.use(express.static(distPath));
      app.get("*", (req, res) => {
        // Never serve HTML for API routes — return 404 JSON instead
        if (req.path.startsWith('/api/')) {
          return res.status(404).json({ error: 'API endpoint not found' });
        }
        res.sendFile(path.join(distPath, "index.html"));
      });
    };

    if (process.env.NODE_ENV !== "production") {
      try {
        const vite = await createViteServer({
          server: { middlewareMode: true },
          appType: "spa",
        });
        app.use(vite.middlewares);
        log("Vite dev server started");
      } catch (e) {
        log("Failed to start Vite dev server: " + (e instanceof Error ? e.message : String(e)));
        // Fall back to serving the built dist/ if available
        if (fs.existsSync(distPath)) {
          serveSpaFallback();
          log("Falling back to serving from dist/");
        } else {
          log("WARNING: No dist/ folder found and Vite failed — frontend will not be served");
        }
      }
    } else {
      serveSpaFallback();
    }

    const server = app.listen(PORT, "0.0.0.0", () => {
      log(`Server running on http://0.0.0.0:${PORT}`);
    });

    server.on('error', (err) => {
      log("Server listen error: " + err.message);
    });

  } catch (error) {
    log("Failed to start server: " + (error instanceof Error ? error.message : String(error)));
    process.exit(1);
  }
}

process.on('uncaughtException', (err) => {
  log('Uncaught Exception: ' + err.message);
});

process.on('unhandledRejection', (reason, promise) => {
  log('Unhandled Rejection at: ' + promise + ' reason: ' + reason);
});

startServer();
