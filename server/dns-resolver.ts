import dns from "dns";
import net from "net";
import http from "http";
import https from "https";
import { SourceHostResolvedIp } from "../src/types.ts";

export const DNS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface DnsCacheEntry {
  ips: string[];
  expiresAt: number;
}

const dnsCache = new Map<string, DnsCacheEntry>();

/**
 * Clears the in-memory DNS cache.
 */
export function clearDnsCache(): void {
  dnsCache.clear();
}

/**
 * Returns current number of entries in the in-memory DNS cache (useful for testing).
 */
export function getDnsCacheSize(): number {
  return dnsCache.size;
}

/**
 * Checks whether an IPv4 address is in a private, loopback, or reserved range.
 */
export function isPrivateIp(ip: string): boolean {
  if (!net.isIPv4(ip)) return true;
  return (
    ip.startsWith("127.") ||
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    ip.startsWith("169.254.") ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip) ||
    ip === "0.0.0.0" ||
    ip.startsWith("0.")
  );
}

/**
 * Normalizes host/URL input to a clean hostname string, extracting port and path if present.
 */
export function extractHostname(input: string): { hostname: string; port?: number; path?: string } {
  let trimmed = input.trim();
  let port: number | undefined;
  let path = "/";

  if (trimmed.includes("://")) {
    try {
      const parsed = new URL(trimmed);
      trimmed = parsed.hostname;
      if (parsed.port) {
        port = parseInt(parsed.port, 10);
      }
      if (parsed.pathname && parsed.pathname.length > 0) {
        path = parsed.pathname;
      }
    } catch {
      trimmed = trimmed.replace(/^[a-zA-Z]+:\/\//, "");
      const slashIdx = trimmed.indexOf("/");
      if (slashIdx !== -1) {
        path = trimmed.slice(slashIdx);
        trimmed = trimmed.slice(0, slashIdx);
      }
      if (trimmed.includes(":") && !trimmed.includes("]")) {
        const parts = trimmed.split(":");
        trimmed = parts[0];
        port = parseInt(parts[1], 10);
      }
    }
  } else if (trimmed.includes("/")) {
    const slashIdx = trimmed.indexOf("/");
    path = trimmed.slice(slashIdx);
    trimmed = trimmed.slice(0, slashIdx);
    if (trimmed.includes(":") && !trimmed.includes("]")) {
      const parts = trimmed.split(":");
      trimmed = parts[0];
      port = parseInt(parts[1], 10);
    }
  } else if (trimmed.includes(":") && !trimmed.includes("]")) {
    const parts = trimmed.split(":");
    trimmed = parts[0];
    port = parseInt(parts[1], 10);
  }

  return { hostname: trimmed.toLowerCase(), port, path };
}

/**
 * Resolves all IPv4 A-records for a hostname.
 * Uses dns.promises.resolve4 with fallback to dns.promises.lookup.
 * Caches non-empty results for 5 minutes.
 */
export async function resolveHostIps(
  hostname: string,
  forceRefresh = false,
  filterPrivate = false
): Promise<string[]> {
  const { hostname: cleanHost } = extractHostname(hostname);

  if (!cleanHost) {
    return [];
  }

  // If already an IPv4 address, return directly
  if (net.isIPv4(cleanHost)) {
    if (filterPrivate && isPrivateIp(cleanHost)) {
      return [];
    }
    return [cleanHost];
  }

  const now = Date.now();
  if (!forceRefresh) {
    const cached = dnsCache.get(cleanHost);
    if (cached && cached.expiresAt > now) {
      const result = filterPrivate ? cached.ips.filter((ip) => !isPrivateIp(ip)) : cached.ips;
      return [...result];
    }
  }

  let resolvedIps: string[] = [];

  try {
    const res4 = await dns.promises.resolve4(cleanHost);
    if (Array.isArray(res4)) {
      resolvedIps = res4;
    }
  } catch {
    // Fallback: dns.promises.lookup with all: true
    try {
      const lookupResult = await dns.promises.lookup(cleanHost, { all: true, family: 4 });
      if (Array.isArray(lookupResult)) {
        resolvedIps = lookupResult.map((r) => r.address);
      } else if (lookupResult && typeof lookupResult === "object" && "address" in lookupResult) {
        resolvedIps = [(lookupResult as { address: string }).address];
      }
    } catch {
      try {
        const single = await dns.promises.lookup(cleanHost);
        if (single?.address && net.isIPv4(single.address)) {
          resolvedIps = [single.address];
        }
      } catch {
        resolvedIps = [];
      }
    }
  }

  // Validate IPv4 and deduplicate
  const uniqueIps = Array.from(new Set(resolvedIps.filter((ip) => net.isIPv4(ip))));

  if (uniqueIps.length > 0) {
    dnsCache.set(cleanHost, {
      ips: uniqueIps,
      expiresAt: now + DNS_CACHE_TTL_MS,
    });
  }

  if (filterPrivate) {
    return uniqueIps.filter((ip) => !isPrivateIp(ip));
  }

  return uniqueIps;
}

/**
 * Creates an http.Agent or https.Agent that pins TCP connections to targetIp
 * while preserving hostname semantics (Host header and TLS SNI).
 * Handles Node 20+ Happy Eyeballs options.all signature.
 */
export function createIpPinnedAgent(
  targetIp: string,
  isHttps = false,
  customOptions?: http.AgentOptions | https.AgentOptions
): http.Agent | https.Agent {
  const agentOptions = {
    keepAlive: false,
    rejectUnauthorized: false,
    ...customOptions,
    lookup: (
      hostname: string,
      options: any,
      callback: (err: NodeJS.ErrnoException | null, address?: any, family?: number) => void
    ) => {
      if (typeof options === "function") {
        callback = options;
        options = {};
      }
      if (options?.all) {
        callback(null, [{ address: targetIp, family: 4 }]);
      } else {
        callback(null, targetIp, 4);
      }
    },
  };

  return isHttps ? new https.Agent(agentOptions) : new http.Agent(agentOptions);
}

/**
 * Lightweight probe that measures latency to a specific IP for a given hostname.
 * Connects to targetIp via pinned agent with Host header, detaches on first byte/headers.
 * Returns latency in ms, or null on timeout/error.
 */
export function measureIpLatency(
  hostname: string,
  ip: string,
  port?: number,
  isHttps = false,
  timeoutMs = 3000
): Promise<number | null> {
  return new Promise((resolve) => {
    const { hostname: cleanHost, port: extractedPort, path: extractedPath } = extractHostname(hostname);
    const effectivePort = port ?? extractedPort ?? (isHttps ? 443 : 80);
    const reqPath = extractedPath || "/";
    const agent = createIpPinnedAgent(ip, isHttps);
    const transport = isHttps ? https : http;

    const startTime = Date.now();
    let settled = false;

    const timer = setTimeout(() => {
      finalize(null);
    }, timeoutMs);

    const finalize = (latency: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        agent.destroy();
      } catch {
        // ignore
      }
      resolve(latency);
    };

    const req = transport.request(
      {
        method: "GET",
        host: cleanHost,
        port: effectivePort,
        path: reqPath,
        agent,
        headers: {
          Host: cleanHost,
          "User-Agent": "Gecko/1.0",
          Connection: "close",
        },
        timeout: timeoutMs,
      },
      (res) => {
        // Any HTTP response (including 4xx/5xx) indicates network reachability
        const elapsed = Math.max(1, Date.now() - startTime);
        res.resume();
        req.destroy();
        finalize(elapsed);
      }
    );

    req.on("timeout", () => {
      req.destroy();
      finalize(null);
    });

    req.on("error", () => {
      finalize(null);
    });

    req.end();
  });
}

/**
 * Resolves all IPs for a host, measures their latencies concurrently,
 * and returns them sorted by latency ascending (unresponsive at the end).
 */
export async function rankHostIps(
  hostname: string,
  port?: number,
  isHttps = false,
  timeoutMs = 3000
): Promise<SourceHostResolvedIp[]> {
  const ips = await resolveHostIps(hostname);
  if (!ips || ips.length === 0) {
    return [];
  }

  const results = await Promise.all(
    ips.map(async (ip): Promise<SourceHostResolvedIp> => {
      const latencyMs = await measureIpLatency(hostname, ip, port, isHttps, timeoutMs);
      return {
        ip,
        latencyMs,
        healthy: latencyMs !== null,
      };
    })
  );

  return results.sort((a, b) => {
    if (a.healthy && b.healthy) {
      return (a.latencyMs ?? 0) - (b.latencyMs ?? 0);
    }
    if (a.healthy && !b.healthy) return -1;
    if (!a.healthy && b.healthy) return 1;
    return 0;
  });
}
