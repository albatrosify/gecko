import { Router } from "express";
import axios from "axios";
import { requireAuth, AuthRequest } from "../auth.ts";
import { getDb, toId, docsWithId } from "../db.ts";
import { log } from "../logger.ts";

export function createEpgsRouter() {
  const router = Router();

  // =====================================
  // CRUD: EPGs
  // =====================================
  router.get("/epgs", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const docs = await db.collection('epgs').find({ userId: req.user!.id }).toArray();
    res.json(docsWithId(docs));
  });

  router.post("/epgs", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const epg = {
      ...req.body,
      userId: req.user!.id,
      enabled: true,
    };
    const result = await db.collection('epgs').insertOne(epg);
    res.status(201).json({ id: result.insertedId.toString(), ...epg });
  });

  router.delete("/epgs/:id", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    await db.collection('epgs').deleteOne({ _id: toId(req.params.id), userId: req.user!.id });
    epgChannelCache.clear(); // EPG removed — could affect any playlist, clear all
    res.json({ success: true });
  });

  // EPG channel list — parses <channel> elements from all EPG sources for a playlist.
  // Only reads up to the first <programme> tag so large files are fast.
  // Cached in-memory per playlist for 1 hour.
  const epgChannelCache = new Map<string, { channels: {id: string; name: string; icon?: string; source: string}[]; expiresAt: number }>();

  /**
   * Invalidates the EPG channel cache for a specific playlist.
   */
  (router as any).invalidateEpgChannelCache = (playlistId: string) => {
    epgChannelCache.delete(playlistId);
  };

  router.get("/epg-channels", requireAuth, async (req: AuthRequest, res) => {
    const { playlistId } = req.query;
    if (!playlistId) return res.status(400).json({ error: 'playlistId required' });

    const cached = epgChannelCache.get(playlistId as string);
    if (cached && Date.now() < cached.expiresAt) return res.json({ channels: cached.channels });

    const db = getDb();
    const playlistDoc = await db.collection('playlists').findOne({ _id: toId(playlistId as string) });
    if (!playlistDoc) return res.status(404).json({ error: 'Playlist not found' });

    const fetchXmlHead = async (url: string, sourceName: string): Promise<string> => {
      try {
        log(`[EPG] Fetching channels from "${sourceName}" (${url.slice(0, 80)}...)`);
        const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
        let data = Buffer.from(response.data);
        if (url.endsWith('.gz') || response.headers['content-encoding'] === 'gzip') {
          const zlib = await import('zlib');
          data = zlib.gunzipSync(data);
        }
        const text = data.toString('utf-8');
        const cutoff = text.indexOf('<programme');
        return cutoff > 0 ? text.slice(0, cutoff) : text;
      } catch (err: any) {
        log(`[EPG] Failed to fetch "${sourceName}": ${err?.message || err}`);
        return '';
      }
    };

    const xmlSources: { xml: string; sourceName: string }[] = [];

    // Custom EPG sources
    const epgIds: string[] = playlistDoc.epgIds || [];
    log(`[EPG] Playlist ${playlistId}: ${epgIds.length} custom EPG(s), sourceIds=${(playlistDoc.sourceIds || []).length}`);
    if (epgIds.length) {
      const epgDocs = await db.collection('epgs').find({ _id: { $in: epgIds.map(toId) } }).toArray();
      log(`[EPG] Resolved ${epgDocs.length}/${epgIds.length} custom EPG docs from DB`);
      for (const e of epgDocs) {
        if (e.url) xmlSources.push({ xml: await fetchXmlHead(e.url, e.name || e.url), sourceName: e.name || e.url });
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
        xmlSources.push({ xml: await fetchXmlHead(url, `Upstream: ${s.name || s.url}`), sourceName: `Upstream: ${s.name || s.url}` });
      }
    }

    // Parse <channel> elements, tag each with its source name
    const channels: {id: string; name: string; icon?: string; source: string}[] = [];
    const seen = new Set<string>();
    for (const { xml, sourceName } of xmlSources) {
      const before = channels.length;
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
      log(`[EPG] "${sourceName}": ${channels.length - before} channels parsed`);
    }

    log(`[EPG] Total channels for playlist ${playlistId}: ${channels.length}`);
    epgChannelCache.set(playlistId as string, { channels, expiresAt: Date.now() + 3600_000 });
    res.json({ channels });
  });

  return router;
}
