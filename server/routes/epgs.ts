import { Router } from "express";
import axios from "axios";
import { requireAuth, AuthRequest } from "../auth.ts";
import { getDb } from "../db.ts";
import { generateId } from "../db.ts";
import { log } from "../logger.ts";

export function createEpgsRouter() {
  const router = Router();

  // =====================================
  // CRUD: EPGs
  // =====================================
  router.get("/epgs", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const { epgs: schemaEpgs } = await import('../schema.ts');
    const { eq } = await import('drizzle-orm');
    const docs = db.select().from(schemaEpgs).where(eq(schemaEpgs.userId, req.user!.id)).all();

    const formatted = docs.map(d => {
      const extra = (d.extra as any) || {};
      return { id: d.id, userId: d.userId, name: d.name, url: d.url, ...extra };
    });
    res.json(formatted);
  });

  router.post("/epgs", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const { epgs: schemaEpgs } = await import('../schema.ts');
    const newId = generateId();
    const { name, url, ...extra } = req.body;

    db.insert(schemaEpgs).values({
      id: newId,
      userId: req.user!.id,
      name,
      url,
      extra: { ...extra, enabled: true }
    }).run();

    res.status(201).json({ id: newId, userId: req.user!.id, name, url, ...extra, enabled: true });
  });

  router.delete("/epgs/:id", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const { epgs: schemaEpgs } = await import('../schema.ts');
    const { eq, and } = await import('drizzle-orm');
    db.delete(schemaEpgs).where(and(eq(schemaEpgs.id, req.params.id), eq(schemaEpgs.userId, req.user!.id))).run();
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
    const { playlists: schemaPlaylists, epgs: schemaEpgs, sources: schemaSources } = await import('../schema.ts');
    const { eq, inArray, and } = await import('drizzle-orm');

    const playlistDoc = db.select().from(schemaPlaylists).where(eq(schemaPlaylists.id, playlistId as string)).get();
    if (!playlistDoc) return res.status(404).json({ error: 'Playlist not found' });
    const pExtra = (playlistDoc.extra as any) || {};
    const sourceIds: string[] = Array.isArray(playlistDoc.sourceIds) ? playlistDoc.sourceIds : [];

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

    const fetchPromises: Promise<{ xml: string; sourceName: string }>[] = [];

    // Custom EPG sources
    const epgIds: string[] = pExtra.epgIds || [];
    log(`[EPG] Playlist ${playlistId}: ${epgIds.length} custom EPG(s), sourceIds=${sourceIds.length}`);
    if (epgIds.length) {
      const epgDocs = db.select().from(schemaEpgs).where(inArray(schemaEpgs.id, epgIds)).all();
      log(`[EPG] Resolved ${epgDocs.length}/${epgIds.length} custom EPG docs from DB`);
      for (const e of epgDocs) {
        if (e.url) {
          const sourceName = e.name || e.url;
          fetchPromises.push(
            fetchXmlHead(e.url, sourceName).then(xml => ({ xml, sourceName }))
          );
        }
      }
    }

    // Upstream sources with useUpstreamEpg
    const sourceDocs = sourceIds.length > 0
      ? db.select().from(schemaSources).where(inArray(schemaSources.id, sourceIds)).all()
      : [];

    for (const s of sourceDocs) {
      const sExtra = (s.extra as any) || {};
      if (sExtra.useUpstreamEpg && s.url && s.username) {
        const url = `${s.url}/xmltv.php?username=${encodeURIComponent(s.username)}&password=${encodeURIComponent(s.password!)}`;
        const sourceName = `Upstream: ${s.name || s.url}`;
        fetchPromises.push(
          fetchXmlHead(url, sourceName).then(xml => ({ xml, sourceName }))
        );
      }
    }

    const xmlSources = await Promise.all(fetchPromises);

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
