import axios from "axios";
import pLimit from "p-limit";
import { getDb, generateId } from "./db.ts";
import { sources, source_host_logs } from "./schema.ts";
import { XtreamClient } from "./xtream.ts";
import { log } from "./logger.ts";
import { getCached } from "./cache.ts";
import { eq } from "drizzle-orm";
import { SourceHost } from "../src/types.ts";

const PROBE_CAP_BYTES = 512 * 1024; // 512KB
const PROBE_MAX_MS = 3000;
const PROBE_TIMEOUT = 8000;

const limit = pLimit(2);

/**
 * In-memory buffer of host usage counters, flushed to the DB on an interval
 * to avoid a write on every proxied stream.
 */
const hostStatsBuffer = new Map<
  string,
  { sourceId: string; hostUrl: string; uses: number; failures: number; lastUsed: string | null; lastError: string | null }
>();

const bufferKey = (sourceId: string, hostUrl: string) => `${sourceId}\u0000${hostUrl}`;

/**
 * Normalize a raw list of host entries (from the API) into ordered SourceHost
 * objects, preserving any existing per-host stats already stored on the source.
 */
export function normalizeHosts(
  hostsInput: any[] | undefined,
  primaryUrl: string,
  existingHosts: SourceHost[] = []
): SourceHost[] {
  const existingByUrl = new Map(existingHosts.map(h => [normalizeUrl(h.url), h]));
  const seen = new Set<string>();
  const out: SourceHost[] = [];

  const push = (raw: any) => {
    const url = normalizeUrl(typeof raw === "string" ? raw : raw?.url);
    if (!url || seen.has(url)) return;
    seen.add(url);
    const prev = existingByUrl.get(url);
    const prevStats = prev
      ? {
          uses: prev.uses ?? 0,
          failures: prev.failures ?? 0,
          lastUsed: prev.lastUsed ?? null,
          lastError: prev.lastError ?? null,
        }
      : { uses: 0, failures: 0, lastUsed: null, lastError: null };

    out.push({
      url,
      label: (typeof raw === "object" && raw?.label) || prev?.label || undefined,
      order: out.length,
      enabled: typeof raw === "object" ? raw.enabled !== false : true,
      latencyMs: (typeof raw === "object" && raw?.latencyMs != null) ? raw.latencyMs : (prev?.latencyMs ?? null),
      authOk: typeof raw === "object" && raw?.authOk !== undefined ? raw.authOk : (prev?.authOk ?? null),
      throughputMbps: (typeof raw === "object" && raw?.throughputMbps != null) ? raw.throughputMbps : (prev?.throughputMbps ?? null),
      probeOk: typeof raw === "object" && raw?.probeOk !== undefined ? raw.probeOk : (prev?.probeOk ?? null),
      lastBenchmark: (typeof raw === "object" && raw?.lastBenchmark) || prev?.lastBenchmark || null,
      ...prevStats,
    });
  };

  // Iterate explicit host entries first so labels/stats are preserved.
  for (const h of hostsInput || []) push(h);

  // Ensure the primary URL is present; prepend it if it wasn't already listed.
  const primary = normalizeUrl(primaryUrl);
  if (primary && !seen.has(primary)) {
    const prev = existingByUrl.get(primary);
    const prevStats = prev
      ? { uses: prev.uses ?? 0, failures: prev.failures ?? 0, lastUsed: prev.lastUsed ?? null, lastError: prev.lastError ?? null }
      : { uses: 0, failures: 0, lastUsed: null, lastError: null };
    out.unshift({
      url: primary,
      label: prev?.label || undefined,
      order: 0,
      enabled: prev?.enabled !== false,
      latencyMs: prev?.latencyMs ?? null,
      authOk: prev?.authOk ?? null,
      throughputMbps: prev?.throughputMbps ?? null,
      probeOk: prev?.probeOk ?? null,
      lastBenchmark: prev?.lastBenchmark || null,
      ...prevStats,
    });
    out.forEach((h, i) => { h.order = i; });
  }

  return out;
}

/**
 * Return the ordered host list for a source, falling back to its primary URL
 * when no explicit host list exists. The primary (active) host is always first.
 */
export function getOrderedHosts(sourceDoc: any): SourceHost[] {
  const hosts = Array.isArray(sourceDoc?.hosts) ? sourceDoc.hosts : [];
  const primary = normalizeUrl(sourceDoc?.url || "");
  return normalizeHosts(hosts, primary, hosts)
    .filter(h => h.enabled !== false)
    .sort((a, b) => {
      const aPrimary = normalizeUrl(a.url) === primary ? 0 : 1;
      const bPrimary = normalizeUrl(b.url) === primary ? 0 : 1;
      if (aPrimary !== bPrimary) return aPrimary - bPrimary;
      return (a.order ?? 0) - (b.order ?? 0);
    });
}

/**
 * Return the ordered host URLs to try for fallback, primary first.
 */
export function getActiveHostUrls(sourceDoc: any): string[] {
  return getOrderedHosts(sourceDoc).map(h => h.url);
}

const normalizeUrl = (url: string | undefined | null): string => {
  if (!url) return "";
  try {
    return String(url).trim().replace(/\/+$/, "");
  } catch {
    return String(url).trim();
  }
};

/**
 * Record a successful or failed proxy use of a host. Buffered in-memory and
 * flushed periodically by initHostStatsFlusher().
 */
export function recordHostUse(sourceId: string, hostUrl: string, ok: boolean, err?: string): void {
  const key = bufferKey(sourceId, hostUrl);
  const entry = hostStatsBuffer.get(key) || {
    sourceId,
    hostUrl,
    uses: 0,
    failures: 0,
    lastUsed: null,
    lastError: null,
  };
  if (ok) {
    entry.uses += 1;
    entry.lastUsed = new Date().toISOString();
    entry.lastError = null;
  } else {
    entry.failures += 1;
    entry.lastError = err || "unknown error";
  }
  hostStatsBuffer.set(key, entry);
}

/**
 * Persist buffered host usage counters back into each source's extra.hosts.
 */
export function flushHostStats(): void {
  if (hostStatsBuffer.size === 0) return;
  const entries = Array.from(hostStatsBuffer.values());
  hostStatsBuffer.clear();

  const db = getDb();
  const bySource = new Map<string, typeof entries>();
  for (const e of entries) {
    const list = bySource.get(e.sourceId) || [];
    list.push(e);
    bySource.set(e.sourceId, list);
  }

  for (const [sourceId, list] of bySource) {
    try {
      const doc = db.select().from(sources).where(eq(sources.id, sourceId)).get();
      if (!doc) continue;
      const extra = (doc.extra as any) || {};
      const hosts: SourceHost[] = normalizeHosts(Array.isArray(extra.hosts) ? extra.hosts : [], doc.url, Array.isArray(extra.hosts) ? extra.hosts : []);
      const byUrl = new Map(hosts.map(h => [normalizeUrl(h.url), h]));
      for (const e of list) {
        const h = byUrl.get(normalizeUrl(e.hostUrl));
        if (h) {
          h.uses = (h.uses ?? 0) + e.uses;
          h.failures = (h.failures ?? 0) + e.failures;
          if (e.lastUsed) h.lastUsed = e.lastUsed;
          if (e.lastError) h.lastError = e.lastError;
        }
      }
      db.update(sources).set({ extra: { ...extra, hosts } }).where(eq(sources.id, sourceId)).run();
    } catch (err: any) {
      log(`[Hosts] Failed to flush stats for ${sourceId}: ${err.message}`);
    }
  }
}

let hostStatsTimer: NodeJS.Timeout | null = null;

/**
 * Start the periodic flush of buffered host usage stats.
 */
export function initHostStatsFlusher(): void {
  if (hostStatsTimer) clearInterval(hostStatsTimer);
  hostStatsTimer = setInterval(flushHostStats, 60_000);
}

/**
 * Probe the throughput of a single stream URL, returning Mbps.
 */
async function probeThroughput(url: string): Promise<number> {
  const start = Date.now();
  let bytes = 0;

  const response = await axios({
    method: "get",
    url,
    responseType: "stream",
    timeout: PROBE_TIMEOUT,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) IPTV-Proxy/1.0",
      Range: `bytes=0-${PROBE_CAP_BYTES - 1}`,
    },
    validateStatus: () => true,
  });

  if (response.status >= 400) {
    if (response.data?.destroy) response.data.destroy();
    throw new Error(`upstream returned ${response.status}`);
  }

  return new Promise<number>((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        if (response.data?.destroy) response.data.destroy();
      } catch {}
      const secs = (Date.now() - start) / 1000;
      resolve(secs > 0 ? (bytes * 8) / secs / 1_000_000 : 0);
    };
    const timeout = setTimeout(finish, PROBE_MAX_MS);
    response.data.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes >= PROBE_CAP_BYTES || Date.now() - start >= PROBE_MAX_MS) {
        clearTimeout(timeout);
        finish();
      }
    });
    response.data.on("end", () => { clearTimeout(timeout); finish(); });
    response.data.on("error", (err: any) => {
      if (settled) return;
      clearTimeout(timeout);
      settled = true;
      reject(err);
    });
  });
}

/**
 * Benchmark all hosts of a source: measure auth latency and stream throughput,
 * reorder by speed, and set the primary URL to the fastest healthy host.
 */
export async function benchmarkSourceHosts(sourceId: string): Promise<any> {
  const db = getDb();
  flushHostStats();
  const doc = db.select().from(sources).where(eq(sources.id, sourceId)).get();
  if (!doc) throw new Error("Source not found");
  if (doc.type !== "xtream") throw new Error("Benchmarking is only supported for Xtream Codes sources");

  const extra = (doc.extra as any) || {};
  const hosts = normalizeHosts(Array.isArray(extra.hosts) ? extra.hosts : [], doc.url, Array.isArray(extra.hosts) ? extra.hosts : []);

  const now = new Date().toISOString();
  const results: SourceHost[] = [];

  await Promise.all(hosts.map(h => limit(async () => {
    const client = new XtreamClient({ id: sourceId, name: doc.name, type: "xtream", url: h.url, username: doc.username || undefined, password: doc.password || undefined } as any);

    const r: SourceHost = { ...h };
    r.lastBenchmark = now;

    // 1. Auth latency + validity
    const authStart = Date.now();
    try {
      const auth = await client.authenticate();
      r.latencyMs = Date.now() - authStart;
      r.authOk = !!(auth && auth.user_info);
    } catch (err: any) {
      r.latencyMs = null;
      r.authOk = false;
      r.lastError = err.message;
    }

    // 2. Stream throughput probe
    if (r.authOk) {
      try {
        let streamId: any = null;
        const cached = getCached(`${sourceId}_streams_live`);
        const streams = cached?.data ?? await client.getLiveStreams().catch(() => []);
        if (Array.isArray(streams) && streams.length > 0) {
          streamId = streams[0].stream_id ?? streams[0].streamId;
        }
        if (streamId != null) {
          const probeUrl = client.getLiveStreamUrl(streamId);
          r.throughputMbps = await probeThroughput(probeUrl);
          r.probeOk = true;
        } else {
          r.probeOk = false;
        }
      } catch (err: any) {
        r.probeOk = false;
        r.throughputMbps = null;
        if (!r.lastError) r.lastError = err.message;
      }
    } else {
      r.probeOk = false;
      r.throughputMbps = null;
    }

    results.push(r);
  })));

  // Sort: healthy hosts first by latency ascending, then failed hosts
  const sorted = results
    .map((h, i) => ({ ...h, order: i }))
    .sort((a, b) => {
      const aOk = a.authOk ? 0 : 1;
      const bOk = b.authOk ? 0 : 1;
      if (aOk !== bOk) return aOk - bOk;
      if (aOk === 0) {
        const aLat = a.latencyMs ?? Number.MAX_SAFE_INTEGER;
        const bLat = b.latencyMs ?? Number.MAX_SAFE_INTEGER;
        if (aLat !== bLat) return aLat - bLat;
      }
      return (a.order ?? 0) - (b.order ?? 0);
    })
    .map((h, i) => ({ ...h, order: i }));

  const primary = sorted.find(h => h.authOk) || sorted[0];

  const newExtra = { ...extra, hosts: sorted };
  db.update(sources)
    .set({ url: primary?.url || doc.url, extra: newExtra })
    .where(eq(sources.id, sourceId)).run();

  // Record benchmark history
  const logId = generateId();
  db.insert(source_host_logs).values({
    id: logId,
    sourceId,
    timestamp: now,
    results: sorted.map(h => ({
      url: h.url,
      label: h.label,
      latencyMs: h.latencyMs,
      authOk: h.authOk,
      throughputMbps: h.throughputMbps,
      probeOk: h.probeOk,
    })),
  }).run();

  log(`[Hosts] Benchmark completed for ${doc.name}: ${sorted.filter(h => h.authOk).length}/${sorted.length} hosts healthy`);

  return {
    success: true,
    activeHost: primary?.url || null,
    hosts: sorted,
  };
}

/**
 * Retrieve benchmark history for a source.
 */
export function getHostBenchmarkHistory(sourceId: string, limit: number = 50): any[] {
  const db = getDb();
  const rows = db.select()
    .from(source_host_logs)
    .where(eq(source_host_logs.sourceId, sourceId))
    .all();

  rows.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  return rows.slice(0, limit).map(r => ({
    id: r.id,
    sourceId: r.sourceId,
    timestamp: r.timestamp,
    results: r.results || [],
  }));
}
