import path from "path";
import fs from "fs";
import zlib from "zlib";
import { promisify } from "util";
import axios from "axios";
import type { Request, Response } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "./db.ts";
import { log } from "./logger.ts";
import { proxyXmlIcons } from "./utils.ts";
import { measureSync } from "./event-loop-monitor.ts";
import { requestEpgBuild } from "./sync-client.ts";
import { mappings as schemaMappings, streams as schemaStreams } from "./schema.ts";
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
    await refreshPlaylistEpg(playlist, imgBase);
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
 * Parsed top-level XMLTV blocks of a single source feed.
 */
interface ParsedSourceTv {
  /** channel id -> first `<channel>` block defined by this source */
  channels: Map<string, string>;
  /** channel id -> `<programme>` blocks in encounter order */
  programmes: Map<string, string[]>;
}

/**
 * Single-pass parse of one source's top-level XMLTV blocks. Runs exclusively in
 * the sync worker (background role), so linear scans over very large strings are
 * acceptable; the serving process never runs this.
 */
export function parseTvBlocks(xml: string): ParsedSourceTv {
  const startTag = xml.indexOf('<tv');
  let src = xml;
  if (startTag !== -1) {
    const start = xml.indexOf('>', startTag) + 1;
    const end = xml.lastIndexOf('</tv>');
    if (start > 0 && end > start) src = xml.slice(start, end);
  }

  const channels = new Map<string, string>();
  const programmes = new Map<string, string[]>();
  let pos = 0;
  const len = src.length;
  while (pos < len) {
    const chIdx = src.indexOf('<channel', pos);
    const prIdx = src.indexOf('<programme', pos);
    if (chIdx === -1 && prIdx === -1) break;
    const isChannel = chIdx !== -1 && (prIdx === -1 || chIdx < prIdx);
    const tagStart = isChannel ? chIdx : prIdx;

    const openEnd = src.indexOf('>', tagStart);
    const openTag = openEnd === -1 ? src.slice(tagStart) : src.slice(tagStart, openEnd + 1);
    const selfClosing = /\/>\s*$/.test(openTag);
    const endTag = isChannel ? '</channel>' : '</programme>';
    const closeIdx = selfClosing ? openEnd : src.indexOf(endTag, openEnd + 1);
    const blockEnd = selfClosing ? openEnd + 2 : (closeIdx === -1 ? len : closeIdx + endTag.length);
    const block = src.slice(tagStart, blockEnd);
    pos = blockEnd;

    if (isChannel) {
      const id = block.match(/\bid="([^"]*)"/)?.[1] ?? '';
      if (id && !channels.has(id)) channels.set(id, block);
    } else {
      const channelId = block.match(/\bchannel="([^"]*)"/)?.[1] ?? '';
      if (channelId) {
        const list = programmes.get(channelId);
        if (list) list.push(block);
        else programmes.set(channelId, [block]);
      }
    }
  }
  return { channels, programmes };
}

/**
 * A playlist channel's EPG binding: which XMLTV channel id it plays against and
 * where the definition should come from.
 */
interface ChannelBinding {
  id: string;
  /** `true` = user override from the UI (mappings.epgMapping), false = upstream default */
  fromOverride: boolean;
  /** name of the EPG source the override was picked from (stored in the mapping) */
  ownerSourceName?: string;
}

/**
 * Resolves the effective EPG binding for every exported live channel of a
 * playlist:
 * - Manual override (`mappings.epgMapping`) wins — that is the "fix wrong
 *   entries / add missing ones" layer.
 * - Otherwise the upstream's own pairing (`streams.epgChannelId`) applies —
 *   "Use upstream EPG" behavior. If the upstream has no pairing, the channel
 *   stays unbound (no automatic fallback to the other EPG docs, by design).
 * Channels hidden by a mapping are excluded.
 */
export function collectPlaylistEpgBindings(playlist: Playlist): ChannelBinding[] {
  const db = getDb();
  const sourceIds = (Array.isArray((playlist as any).sourceIds) ? (playlist as any).sourceIds : []) as string[];
  if (!sourceIds.length) return [];

  // Manual overrides, keyed `${sourceIdx}_${originalId}` (older rows without
  // sourceIdx additionally match the unprefixed form).
  const overridesByKey = new Map<string, any>();
  const mappingRows = db.select().from(schemaMappings).where(eq(schemaMappings.playlistId, playlist.id)).all();
  for (const m of mappingRows) {
    if (m.type !== 'live') continue;
    let extra: any = {};
    try { extra = JSON.parse((m.extra as any) || '{}'); } catch { /* tolerate bad rows */ }
    if (extra?.sourceIdx !== undefined && extra?.sourceIdx !== null) {
      overridesByKey.set(`${extra.sourceIdx}_${m.originalId}`, extra);
    }
    overridesByKey.set(`_${m.originalId}`, extra);
  }

  const bindings: ChannelBinding[] = [];
  const seen = new Set<string>();
  const streamRows = db.select({
    sourceId: schemaStreams.sourceId,
    streamId: schemaStreams.streamId,
    epgChannelId: schemaStreams.epgChannelId,
  }).from(schemaStreams)
    .where(and(inArray(schemaStreams.sourceId, sourceIds), eq(schemaStreams.type, 'live')))
    .all();
  for (const st of streamRows) {
    const sourceIdx = sourceIds.indexOf(st.sourceId);
    const ov = overridesByKey.get(`${sourceIdx}_${st.streamId}`);
    if (ov?.hidden) continue; // hidden channels are not exported
    let id = String(ov?.epgMapping ?? '').trim();
    let fromOverride = id.length > 0;
    if (!id) {
      id = String(st.epgChannelId ?? '').trim();
      if (!id) continue; // no upstream pairing either → intentionally unbound
    }
    if (seen.has(id)) continue;
    seen.add(id);
    const binding: ChannelBinding = { id, fromOverride };
    if (fromOverride && ov?.epgSource) binding.ownerSourceName = String(ov.epgSource);
    bindings.push(binding);
  }
  return bindings;
}

/**
 * Refreshes or builds the EPG cache for a given playlist.
 * Deduplicates concurrent requests for the same playlist.
 */
export async function refreshPlaylistEpg(playlist: Playlist, imgBase: string): Promise<void> {
  const playlistId = playlist.id;
  const existing = inFlightBuilds.get(playlistId);
  if (existing) {
    log(`[EPG] Generation already in progress for playlist ${playlist.name || playlistId}, awaiting in-flight build`);
    return existing;
  }

  const buildPromise = (async () => {
    await requestEpgBuild(playlist, imgBase);
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
 *
 * Runs in the sync-worker process (see `requestEpgBuild`): the synchronous string
 * work (XML ampersand-escape, icon regex rewrite, `join`, `Buffer.from`) is on the
 * order of the full ~100 MB feed, so it must not run on the serving event loop.
 */
export async function buildEpgCache(playlist: Playlist, imgBase: string): Promise<void> {
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

  // Each fetched feed keeps its title so channel definitions can be resolved by
  // owner later: custom EPG docs by their name, upstream XMLTVs as
  // `Upstream: <sourceName>` (the same labels the UI stores in mappings.epgSource).
  const sourceData: { title: string; xml: string; isUpstream: boolean }[] = [];
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
        if (xml) sourceData.push({ title: epgDoc.name, xml, isUpstream: false });
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
      if (xml) sourceData.push({ title: `Upstream: ${sourceRow.name || sourceRow.id}`, xml, isUpstream: true });
    }));
  }

  await Promise.all(fetchPromises);
  await yieldLoop();

  // Defensive guard: if sources were expected but all failed, do not overwrite a valid existing cache
  if (!sourceData.length && expectedSourcesCount > 0 && fs.existsSync(cachePath)) {
    throw new Error(`All ${expectedSourcesCount} EPG sources failed to fetch; preserving existing cache.`);
  }

  // Playlist-scoped assembly instead of a blind merge: resolve what every exported
  // channel is bound to (manual override first, else the upstream pairing), take
  // channel + programme definitions from the owning source, and drop every channel
  // (and its programmes) that the playlist does not export. This keeps the output
  // unique per channel id and orders of magnitude smaller for players.
  const bindings = collectPlaylistEpgBindings(playlist);
  const parsedSources = measureSync('epg:assemble', () => sourceData.map(s => ({ title: s.title, tv: parseTvBlocks(s.xml) })));
  const inputChannelCount = parsedSources.reduce((n, p) => n + p.tv.channels.size, 0);
  const upstreamTitles = new Set(sourceData.filter(s => s.isUpstream).map(s => s.title));

  const inner: string[] = [];
  let emittedChannels = 0;
  let emittedProgrammes = 0;
  let unboundChannels = 0;
  for (const binding of bindings) {
    let owner: { title: string; tv: ParsedSourceTv } | undefined;
    const hasId = (p: { tv: ParsedSourceTv }) => p.tv.channels.has(binding.id);
    if (binding.fromOverride) {
      if (binding.ownerSourceName) {
        owner = parsedSources.find(p => p.title === binding.ownerSourceName);
      }
      // Override definition missing in its source (renamed doc etc.) → any
      // source that defines the id; EPG docs take priority over upstream.
      if (!owner || !hasId(owner)) {
        owner = parsedSources.find(p => !upstreamTitles.has(p.title) && hasId(p))
          ?? parsedSources.find(hasId);
      }
    } else {
      // Default: exactly the upstream pairing. No fallback to other docs —
      // those only apply through manual mappings (the override layer).
      owner = parsedSources.find(p => upstreamTitles.has(p.title) && hasId(p));
      if (!owner) unboundChannels++;
    }

    const channelBlock = owner?.tv.channels.get(binding.id);
    if (!channelBlock) continue;
    inner.push(channelBlock, '\n');
    emittedChannels++;
    const progs = owner!.tv.programmes.get(binding.id) ?? [];
    for (const prog of progs) {
      inner.push(prog, '\n');
      emittedProgrammes++;
    }
    await yieldLoop();
  }
  sourceData.length = 0; // free the raw feeds before the assembly phase

  const finalXml = measureSync('epg:proxy-icons', () =>
    `${'<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n'}${proxyXmlIcons(inner.join(''), imgBase)}\n</tv>`);

  await yieldLoop();
  const compressed = await gzipAsync(measureSync('epg:to-buffer', () => Buffer.from(finalXml, 'utf-8')));
  const tempPath = `${cachePath}.tmp.${Date.now()}`;
  await fs.promises.writeFile(tempPath, compressed);
  await fs.promises.rename(tempPath, cachePath);
  log(`[EPG] Cache generated for playlist ${playlist.name || playlist.id}: ${emittedChannels}/${bindings.length} binding(s) emitted (${emittedProgrammes} programmes, ${unboundChannels} unbound upstream pairings), ${inputChannelCount} input channel defs filtered down to the exported set (${(compressed.length / 1024).toFixed(0)} KB gzipped)`);
}
