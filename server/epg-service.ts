import path from "path";
import fs from "fs";
import zlib from "zlib";
import { promisify } from "util";
import axios from "axios";
import type { Request, Response } from "express";
import { getDb } from "./db.ts";
import { log } from "./logger.ts";
import { proxyXmlIcons } from "./utils.ts";
import type { Playlist } from "../src/types.ts";

const gunzipAsync = promisify(zlib.gunzip);
const gzipAsync = promisify(zlib.gzip);
const yieldLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Cache fresh duration: 6 hours */
export const EPG_CACHE_FRESH_MS = 6 * 60 * 60 * 1000;
/** Maximum cache age before considered expired: 24 hours */
export const EPG_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** In-flight deduplication to prevent multiple concurrent EPG builds for the same playlist */
const inFlightBuilds = new Map<string, Promise<void>>();

/**
 * Returns the base directory for EPG disk cache files.
 */
export function getEpgCacheDir(): string {
  if (process.env.EPG_CACHE_DIR) {
    return process.env.EPG_CACHE_DIR;
  }
  if (process.env.SQLITE_PATH && process.env.SQLITE_PATH !== ':memory:') {
    return path.join(path.dirname(path.resolve(process.env.SQLITE_PATH)), 'epg-cache');
  }
  return path.join(process.cwd(), 'data', 'epg-cache');
}

/**
 * Returns the sanitized file path for a playlist's cached EPG file.
 */
export function getEpgCachePath(playlistId: string): string {
  const safeId = playlistId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(getEpgCacheDir(), `epg_${safeId}.xml.gz`);
}

/**
 * Clears the cached EPG file for a specific playlist or all playlists.
 */
export async function clearEpgCache(playlistId?: string): Promise<void> {
  const cacheDir = getEpgCacheDir();
  try {
    if (playlistId) {
      const cachePath = getEpgCachePath(playlistId);
      if (fs.existsSync(cachePath)) {
        await fs.promises.unlink(cachePath);
        log(`[EPG] Cleared cache for playlist ${playlistId}`);
      }
    } else if (fs.existsSync(cacheDir)) {
      const files = await fs.promises.readdir(cacheDir);
      for (const file of files) {
        if (file.endsWith('.xml.gz')) {
          await fs.promises.unlink(path.join(cacheDir, file));
        }
      }
      log(`[EPG] Cleared all cached EPG files`);
    }
  } catch (err: any) {
    log(`[EPG] Error clearing EPG cache: ${err.message}`);
  }
}

/**
 * Streams a pre-compressed EPG file directly to the client HTTP response.
 * Uses zero-copy pipe when gzip is supported, or streaming gunzip otherwise.
 */
export function streamEpgFile(req: Request, res: Response, filePath: string): void {
  const acceptEncoding = (req.headers['accept-encoding'] || '').toString();
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');

  if (acceptEncoding.includes('gzip')) {
    res.setHeader('Content-Encoding', 'gzip');
    const readStream = fs.createReadStream(filePath);
    readStream.on('error', (err) => {
      log(`[EPG] Error streaming gzipped EPG: ${err.message}`);
      if (!res.headersSent && typeof res.status === 'function') res.status(500).send("Error reading EPG cache");
    });
    req.on('close', () => {
      readStream.destroy();
    });
    readStream.pipe(res);
  } else {
    const readStream = fs.createReadStream(filePath);
    const gunzip = zlib.createGunzip();
    readStream.on('error', (err) => {
      log(`[EPG] Error reading EPG cache: ${err.message}`);
      if (!res.headersSent && typeof res.status === 'function') res.status(500).send("Error reading EPG cache");
    });
    gunzip.on('error', (err) => {
      log(`[EPG] Error decompressing EPG cache: ${err.message}`);
      if (!res.headersSent && typeof res.status === 'function') res.status(500).send("Error decompressing EPG cache");
    });
    req.on('close', () => {
      readStream.destroy();
      gunzip.destroy();
    });
    readStream.pipe(gunzip).pipe(res);
  }
}

/**
 * Serves the EPG for a playlist.
 *
 * Fast path (<10 ms): Serves pre-compressed file from disk.
 * Stale-while-revalidate: If cache is 6–24 hours old, serves existing cache immediately and triggers background refresh.
 * Cold path / expired: Fetches and builds EPG with in-flight deduplication, using threadpool decompression and non-blocking chunks.
 */
export async function servePlaylistEpg(req: Request, res: Response, playlist: Playlist, imgBase: string): Promise<void> {
  const cachePath = getEpgCachePath(playlist.id);
  const isForce = req.query.force === '1' || req.query.force === 'true';

  let stats: fs.Stats | null = null;
  try {
    stats = await fs.promises.stat(cachePath);
  } catch {
    stats = null;
  }

  if (stats && !isForce) {
    const age = Date.now() - stats.mtimeMs;
    if (age < EPG_CACHE_MAX_AGE_MS) {
      if (age >= EPG_CACHE_FRESH_MS) {
        log(`[EPG] Serving stale cache (${Math.round(age / 60000)} min old) for playlist ${playlist.name || playlist.id}, revalidating in background`);
        refreshPlaylistEpg(playlist, imgBase).catch((err) => {
          log(`[EPG] Background refresh error for playlist ${playlist.name || playlist.id}: ${err.message}`);
        });
      }
      streamEpgFile(req, res, cachePath);
      return;
    }
  }

  // Cache miss, expired, or force refresh requested
  log(`[EPG] Cache miss / refresh requested for playlist ${playlist.name || playlist.id}`);
  try {
    await refreshPlaylistEpg(playlist, imgBase, isForce);
    streamEpgFile(req, res, cachePath);
  } catch (err: any) {
    if (stats) {
      log(`[EPG] Refresh failed (${err.message}), falling back to older cache for playlist ${playlist.name || playlist.id}`);
      streamEpgFile(req, res, cachePath);
      return;
    }
    throw err;
  }
}

/**
 * Refreshes or builds the EPG cache for a given playlist.
 * Deduplicates concurrent requests for the same playlist.
 */
export async function refreshPlaylistEpg(playlist: Playlist, imgBase: string, force: boolean = false): Promise<void> {
  const playlistId = playlist.id;
  const existing = inFlightBuilds.get(playlistId);
  if (existing) {
    log(`[EPG] Generation already in progress for playlist ${playlist.name || playlistId}, awaiting in-flight build`);
    return existing;
  }

  const buildPromise = (async () => {
    await buildEpgCache(playlist, imgBase);
  })();

  inFlightBuilds.set(playlistId, buildPromise);
  try {
    await buildPromise;
  } finally {
    inFlightBuilds.delete(playlistId);
  }
}

/**
 * Core builder that downloads feeds, decompresses asynchronously in the libuv threadpool,
 * yields to the event loop, and writes the gzipped XML to disk atomically.
 */
async function buildEpgCache(playlist: Playlist, imgBase: string): Promise<void> {
  const cachePath = getEpgCachePath(playlist.id);
  const cacheDir = path.dirname(cachePath);
  await fs.promises.mkdir(cacheDir, { recursive: true });

  const fetchXml = async (url: string): Promise<string | null> => {
    try {
      const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
      let data = Buffer.from(response.data);
      if (url.endsWith('.gz') || response.headers['content-encoding'] === 'gzip') {
        data = await gunzipAsync(data);
      }
      await yieldLoop();
      let xml = data.toString('utf-8');
      if (xml.includes('&')) {
        xml = xml.replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);)/gi, '&amp;');
      }
      return xml;
    } catch (err: any) {
      log(`[EPG] Failed to fetch ${url}: ${err.message}`);
      return null;
    }
  };

  const xmlParts: string[] = [];
  const fetchPromises: Promise<void>[] = [];

  const { epgs: schemaEpgs, sources: schemaSources } = await import('./schema.ts');
  const { inArray } = await import('drizzle-orm');
  const db = getDb();

  // 1. Custom EPG sources linked to this playlist
  const epgIds: string[] = playlist.epgIds || [];
  if (epgIds.length) {
    const epgDocs = db.select().from(schemaEpgs).where(inArray(schemaEpgs.id, epgIds)).all();
    for (const epgDoc of epgDocs) {
      if (!epgDoc.url) continue;
      fetchPromises.push(fetchXml(epgDoc.url).then((xml) => {
        if (xml) xmlParts.push(xml);
      }));
    }
  }

  // 2. Upstream sources with useUpstreamEpg enabled
  const playlistSourceIds = (Array.isArray(playlist.sourceIds) ? playlist.sourceIds : []) as string[];
  const sourceDocs = playlistSourceIds.length > 0
    ? db.select().from(schemaSources).where(inArray(schemaSources.id, playlistSourceIds)).all()
    : [];

  let expectedSourcesCount = epgIds.length;
  for (const sourceRow of sourceDocs) {
    const sExtra = (sourceRow.extra as any) || {};
    const overrides = (playlist as any).sourceOverrides?.[sourceRow.id];
    const effectiveUsername = overrides?.username || sourceRow.username;
    const effectivePassword = overrides?.password || sourceRow.password;

    if (!sExtra.useUpstreamEpg || !sourceRow.url || !effectiveUsername) continue;
    expectedSourcesCount++;
    const upstreamEpgUrl = `${sourceRow.url}/xmltv.php?username=${encodeURIComponent(effectiveUsername)}&password=${encodeURIComponent(effectivePassword || '')}`;
    log(`[EPG] Fetching upstream EPG: ${sourceRow.url}/xmltv.php`);
    fetchPromises.push(fetchXml(upstreamEpgUrl).then((xml) => {
      if (xml) xmlParts.push(xml);
    }));
  }

  await Promise.all(fetchPromises);
  await yieldLoop();

  // Defensive guard: if sources were expected but all failed, do not overwrite a valid existing cache
  if (!xmlParts.length && expectedSourcesCount > 0 && fs.existsSync(cachePath)) {
    throw new Error(`All ${expectedSourcesCount} EPG sources failed to fetch; preserving existing cache.`);
  }

  let finalXml = '';
  if (!xmlParts.length) {
    finalXml = '<?xml version="1.0" encoding="UTF-8"?>\n<tv></tv>';
  } else if (xmlParts.length === 1) {
    finalXml = proxyXmlIcons(xmlParts[0], imgBase);
  } else {
    const extractInnerTv = (xml: string): string => {
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

    const mergedChunks: string[] = ['<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n'];
    for (let i = 0; i < xmlParts.length; i++) {
      mergedChunks.push(extractInnerTv(xmlParts[i]));
      if (i < xmlParts.length - 1) mergedChunks.push('\n');
      xmlParts[i] = "";
      await yieldLoop();
    }
    mergedChunks.push('\n</tv>');
    finalXml = mergedChunks.join('');
  }

  await yieldLoop();
  const compressed = await gzipAsync(Buffer.from(finalXml, 'utf-8'));
  const tempPath = `${cachePath}.tmp.${Date.now()}`;
  await fs.promises.writeFile(tempPath, compressed);
  await fs.promises.rename(tempPath, cachePath);
  log(`[EPG] Cache successfully generated and saved for playlist ${playlist.name || playlist.id} (${(compressed.length / 1024 / 1024).toFixed(2)} MB gzipped)`);
}
