import dns from "dns";
import net from "net";
import axios from "axios";
import pLimit from "p-limit";
import { getDb, generateId } from "./db.ts";
import { sources, source_host_logs } from "./schema.ts";
import { XtreamClient } from "./xtream.ts";
import { log } from "./logger.ts";
import { getCached } from "./cache.ts";
import { eq } from "drizzle-orm";
import { SourceHost } from "../src/types.ts";

const PROBE_CAP_BYTES = 2 * 1024 * 1024; // 2MB (enables measuring real 4K / high-bitrate stream speeds)
const PROBE_MAX_MS = 3500; // 3.5s timeout per host
const PROBE_TIMEOUT = 9000;

const limit = pLimit(2);

// Cloudflare IPv4 CIDR blocks
const CLOUDFLARE_IPV4_CIDRS = [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22",
  "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20",
  "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
  "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22"
];

function ipToLong(ip: string): number {
  return ip.split(".").reduce((acc, octet) => ((acc << 8) + parseInt(octet, 10)) >>> 0, 0);
}

function matchCidr(ip: string, cidr: string): boolean {
  const [range, bits = "32"] = cidr.split("/");
  const mask = ~(2 ** (32 - parseInt(bits, 10)) - 1);
  return (ipToLong(ip) & mask) === (ipToLong(range) & mask);
}

function isCloudflareIp(ip: string): boolean {
  if (ip.includes(":")) {
    const lower = ip.toLowerCase();
    return (
      lower.startsWith("2606:4700") ||
      lower.startsWith("2400:cb00") ||
      lower.startsWith("2803:f800") ||
      lower.startsWith("2405:b500") ||
      lower.startsWith("2405:8100") ||
      lower.startsWith("2a06:98c0") ||
      lower.startsWith("2c0f:f248")
    );
  }
  return CLOUDFLARE_IPV4_CIDRS.some(cidr => matchCidr(ip, cidr));
}

function detectCdnFromHeaders(headers: Record<string, any> | undefined | null): string | null {
  if (!headers) return null;
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    h[k.toLowerCase()] = String(v).toLowerCase();
  }

  // Cloudflare
  if (h["cf-ray"] || h["cf-cache-status"] || h["server"]?.includes("cloudflare")) {
    return "Cloudflare";
  }

  // AWS CloudFront
  if (h["x-amz-cf-id"] || h["x-amz-cf-pop"] || h["via"]?.includes("cloudfront") || h["server"]?.includes("cloudfront")) {
    return "CloudFront";
  }

  // Fastly
  if (h["x-fastly-request-id"] || h["x-served-by"]?.includes("cache-") || h["server"]?.includes("fastly")) {
    return "Fastly";
  }

  // Akamai
  if (h["x-akamai-transformed"] || h["x-check-cacheable"] || h["server"]?.includes("akamaighost") || h["server"]?.includes("ghost")) {
    return "Akamai";
  }

  // BunnyCDN
  if (h["server"]?.includes("bunnycdn") || h["b-cdn-cache-status"]) {
    return "BunnyCDN";
  }

  // CDN77
  if (h["server"]?.includes("cdn77") || h["x-77-cache"]) {
    return "CDN77";
  }

  // Imperva / Incapsula
  if (h["x-cdn"]?.includes("incapsula") || h["x-iinfo"]) {
    return "Imperva";
  }

  // Edgio / Edgecast
  if (h["server"]?.includes("ecd") || h["x-ec-cache"]) {
    return "Edgio";
  }

  // G-Core
  if (h["server"]?.includes("gcore") || h["server"]?.includes("edgecenter")) {
    return "G-Core";
  }

  return null;
}

export function guessNetworkType(rawUrl: string): { networkType: 'cdn' | 'direct'; cdnProvider: string | null } {
  let hostname = "";
  try {
    const u = new URL(rawUrl.startsWith("http") ? rawUrl : `http://${rawUrl}`);
    hostname = u.hostname.toLowerCase();
  } catch {
    hostname = rawUrl.replace(/^https?:\/\//, "").split(/[:/]/)[0].toLowerCase();
  }
  if (!hostname) return { networkType: 'direct', cdnProvider: null };

  if (net.isIP(hostname)) {
    return {
      networkType: isCloudflareIp(hostname) ? 'cdn' : 'direct',
      cdnProvider: isCloudflareIp(hostname) ? 'Cloudflare' : null
    };
  }
  if (hostname.startsWith("cf.") || hostname.startsWith("cf-") || hostname.includes(".cf.")) {
    return { networkType: 'cdn', cdnProvider: 'Cloudflare' };
  }
  if (hostname.startsWith("cdn.") || hostname.startsWith("cdn-")) {
    return { networkType: 'cdn', cdnProvider: 'CDN' };
  }
  return { networkType: 'direct', cdnProvider: null };
}

export async function detectHostNetwork(
  rawUrl: string,
  headers?: Record<string, any> | null
): Promise<{ networkType: 'cdn' | 'direct'; cdnProvider: string | null; resolvedIp: string | null }> {
  let hostname = "";
  try {
    const u = new URL(rawUrl.startsWith("http") ? rawUrl : `http://${rawUrl}`);
    hostname = u.hostname;
  } catch {
    hostname = rawUrl.replace(/^https?:\/\//, "").split(/[:/]/)[0];
  }

  if (!hostname) {
    return { networkType: 'direct', cdnProvider: null, resolvedIp: null };
  }

  // 1. If response headers explicitly identify a CDN
  const headerCdn = detectCdnFromHeaders(headers);
  if (headerCdn) {
    let resolvedIp: string | null = null;
    try {
      const lookup = await dns.promises.lookup(hostname).catch(() => null);
      if (lookup?.address) resolvedIp = lookup.address;
    } catch {}
    return { networkType: 'cdn', cdnProvider: headerCdn, resolvedIp };
  }

  // 2. Check if hostname is an IP address
  if (net.isIP(hostname)) {
    if (isCloudflareIp(hostname)) {
      return { networkType: 'cdn', cdnProvider: 'Cloudflare', resolvedIp: hostname };
    }
    return { networkType: 'direct', cdnProvider: null, resolvedIp: hostname };
  }

  const lowerHost = hostname.toLowerCase();
  const isCfSubdomain = lowerHost.startsWith("cf.") || lowerHost.startsWith("cf-") || lowerHost.includes(".cf.");

  // 3. Resolve DNS to check IP CIDR ranges
  let resolvedIp: string | null = null;
  try {
    const lookup = await Promise.race([
      dns.promises.lookup(hostname),
      new Promise<null>((_, reject) => setTimeout(() => reject(new Error("DNS timeout")), 1500))
    ]) as dns.LookupAddress | null;

    if (lookup?.address) {
      resolvedIp = lookup.address;
      if (isCloudflareIp(resolvedIp)) {
        return { networkType: 'cdn', cdnProvider: 'Cloudflare', resolvedIp };
      }
    }
  } catch {}

  // 4. Check CNAME records
  try {
    const cnames = await Promise.race([
      dns.promises.resolveCname(hostname),
      new Promise<string[]>((_, reject) => setTimeout(() => reject(new Error("CNAME timeout")), 1500))
    ]) as string[];

    const cnameStr = (cnames || []).join(" ").toLowerCase();
    if (cnameStr.includes("cloudflare")) return { networkType: 'cdn', cdnProvider: 'Cloudflare', resolvedIp };
    if (cnameStr.includes("cloudfront")) return { networkType: 'cdn', cdnProvider: 'CloudFront', resolvedIp };
    if (cnameStr.includes("fastly")) return { networkType: 'cdn', cdnProvider: 'Fastly', resolvedIp };
    if (cnameStr.includes("akamai")) return { networkType: 'cdn', cdnProvider: 'Akamai', resolvedIp };
    if (cnameStr.includes("b-cdn")) return { networkType: 'cdn', cdnProvider: 'BunnyCDN', resolvedIp };
    if (cnameStr.includes("cdn77")) return { networkType: 'cdn', cdnProvider: 'CDN77', resolvedIp };
  } catch {}

  // 5. Check PTR reverse DNS
  if (resolvedIp) {
    try {
      const ptrs = await Promise.race([
        dns.promises.reverse(resolvedIp),
        new Promise<string[]>((_, reject) => setTimeout(() => reject(new Error("PTR timeout")), 1500))
      ]) as string[];
      const ptrStr = (ptrs || []).join(" ").toLowerCase();
      if (ptrStr.includes("cloudflare")) return { networkType: 'cdn', cdnProvider: 'Cloudflare', resolvedIp };
      if (ptrStr.includes("cloudfront")) return { networkType: 'cdn', cdnProvider: 'CloudFront', resolvedIp };
      if (ptrStr.includes("fastly")) return { networkType: 'cdn', cdnProvider: 'Fastly', resolvedIp };
      if (ptrStr.includes("akamai")) return { networkType: 'cdn', cdnProvider: 'Akamai', resolvedIp };
    } catch {}
  }

  // 6. Subdomain heuristic fallback
  if (isCfSubdomain) {
    return { networkType: 'cdn', cdnProvider: 'Cloudflare', resolvedIp };
  }
  if (lowerHost.startsWith("cdn.") || lowerHost.startsWith("cdn-")) {
    return { networkType: 'cdn', cdnProvider: 'CDN', resolvedIp };
  }

  return { networkType: 'direct', cdnProvider: null, resolvedIp };
}

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

    const initialNetwork = guessNetworkType(url);
    const networkType = (typeof raw === "object" && raw?.networkType !== undefined)
      ? raw.networkType
      : (prev?.networkType !== undefined ? prev.networkType : initialNetwork.networkType);
    const cdnProvider = (typeof raw === "object" && raw?.cdnProvider !== undefined)
      ? raw.cdnProvider
      : (prev?.cdnProvider !== undefined ? prev.cdnProvider : initialNetwork.cdnProvider);
    const resolvedIp = (typeof raw === "object" && raw?.resolvedIp !== undefined)
      ? raw.resolvedIp
      : (prev?.resolvedIp ?? null);

    out.push({
      url,
      label: (typeof raw === "object" && raw?.label) || prev?.label || undefined,
      order: out.length,
      enabled: typeof raw === "object" ? raw.enabled !== false : true,
      latencyMs: (typeof raw === "object" && raw?.latencyMs != null) ? raw.latencyMs : (prev?.latencyMs ?? null),
      authOk: typeof raw === "object" && raw?.authOk !== undefined ? raw.authOk : (prev?.authOk ?? null),
      throughputMbps: (typeof raw === "object" && raw?.throughputMbps != null) ? raw.throughputMbps : (prev?.throughputMbps ?? null),
      probeOk: typeof raw === "object" && raw?.probeOk !== undefined ? raw.probeOk : (prev?.probeOk ?? null),
      networkType,
      cdnProvider,
      resolvedIp,
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
    const initialNetwork = guessNetworkType(primary);
    out.unshift({
      url: primary,
      label: prev?.label || undefined,
      order: 0,
      enabled: prev?.enabled !== false,
      latencyMs: prev?.latencyMs ?? null,
      authOk: prev?.authOk ?? null,
      throughputMbps: prev?.throughputMbps ?? null,
      probeOk: prev?.probeOk ?? null,
      networkType: prev?.networkType !== undefined ? prev.networkType : initialNetwork.networkType,
      cdnProvider: prev?.cdnProvider !== undefined ? prev.cdnProvider : initialNetwork.cdnProvider,
      resolvedIp: prev?.resolvedIp ?? null,
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

  // Determine benchmark stream: use user-flagged stream or auto-detect 4K/UHD channel
  let benchmarkStreamId: any = extra.benchmarkStreamId || null;
  let benchmarkStreamName: string = extra.benchmarkStreamName || "";
  let is4k = false;

  const cached = getCached(`${sourceId}_streams_live`);
  let streams = cached?.data;
  if (!streams) {
    const primaryClient = new XtreamClient({
      id: sourceId,
      name: doc.name,
      type: "xtream",
      url: doc.url,
      username: doc.username || undefined,
      password: doc.password || undefined,
    } as any);
    streams = await primaryClient.getLiveStreams().catch(() => []);
  }

  if (Array.isArray(streams) && streams.length > 0) {
    if (benchmarkStreamId != null) {
      const found = streams.find((s: any) => String(s.stream_id ?? s.streamId) === String(benchmarkStreamId));
      if (found) {
        benchmarkStreamName = found.name || found.stream_name || benchmarkStreamName;
      }
      is4k = /\b(4k|uhd|2160p)\b/i.test(benchmarkStreamName);
    } else {
      // Auto-detect 4K / UHD channel
      const fourK = streams.find((s: any) =>
        /\b(4k|uhd|2160p)\b/i.test(s.name || s.stream_name || "")
      );
      if (fourK) {
        benchmarkStreamId = fourK.stream_id ?? fourK.streamId;
        benchmarkStreamName = fourK.name || fourK.stream_name || "4K Stream";
        is4k = true;
      } else {
        const fhd = streams.find((s: any) =>
          /\b(fhd|1080p)\b/i.test(s.name || s.stream_name || "")
        );
        if (fhd) {
          benchmarkStreamId = fhd.stream_id ?? fhd.streamId;
          benchmarkStreamName = fhd.name || fhd.stream_name || "FHD Stream";
        } else {
          benchmarkStreamId = streams[0].stream_id ?? streams[0].streamId;
          benchmarkStreamName = streams[0].name || streams[0].stream_name || "Stream #1";
        }
      }
    }
  }

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

    // 2. Network & CDN detection
    try {
      const netInfo = await detectHostNetwork(h.url, client.lastResponseHeaders);
      r.networkType = netInfo.networkType;
      r.cdnProvider = netInfo.cdnProvider;
      r.resolvedIp = netInfo.resolvedIp;
    } catch {
      const fallback = guessNetworkType(h.url);
      r.networkType = fallback.networkType;
      r.cdnProvider = fallback.cdnProvider;
      r.resolvedIp = null;
    }

    // 3. Stream throughput probe using selected/detected benchmark stream
    if (r.authOk) {
      try {
        if (benchmarkStreamId != null) {
          const probeUrl = client.getLiveStreamUrl(benchmarkStreamId);
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

  const newExtra = {
    ...extra,
    hosts: sorted,
    ...(benchmarkStreamId ? { benchmarkStreamId, benchmarkStreamName } : {})
  };
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
      networkType: h.networkType,
      cdnProvider: h.cdnProvider,
      resolvedIp: h.resolvedIp,
      streamId: benchmarkStreamId,
      streamName: benchmarkStreamName,
      is4k,
    })),
  }).run();

  log(`[Hosts] Benchmark completed for ${doc.name} using stream ${benchmarkStreamName || benchmarkStreamId || 'default'} (4K: ${is4k}): ${sorted.filter(h => h.authOk).length}/${sorted.length} hosts healthy`);

  return {
    success: true,
    activeHost: primary?.url || null,
    hosts: sorted,
    benchmarkStream: {
      id: benchmarkStreamId,
      name: benchmarkStreamName,
      is4k,
    },
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
