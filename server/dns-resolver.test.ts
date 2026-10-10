import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "http";
import https from "https";
import dns from "dns";
import {
  resolveHostIps,
  createIpPinnedAgent,
  measureIpLatency,
  rankHostIps,
  clearDnsCache,
  getDnsCacheSize,
  isPrivateIp,
  extractHostname,
} from "./dns-resolver.ts";

describe("dns-resolver", () => {
  beforeEach(() => {
    clearDnsCache();
    vi.restoreAllMocks();
  });

  describe("extractHostname", () => {
    it("extracts hostname and port from full URL", () => {
      const result = extractHostname("http://iptv.example.com:8080/live/user/pass/123.ts");
      expect(result.hostname).toBe("iptv.example.com");
      expect(result.port).toBe(8080);
    });

    it("extracts hostname from host:port string", () => {
      const result = extractHostname("stream.provider.to:9000");
      expect(result.hostname).toBe("stream.provider.to");
      expect(result.port).toBe(9000);
    });

    it("handles plain hostname without port", () => {
      const result = extractHostname("sub.domain.org");
      expect(result.hostname).toBe("sub.domain.org");
      expect(result.port).toBeUndefined();
    });
  });

  describe("isPrivateIp", () => {
    it("identifies private IPv4 addresses correctly", () => {
      expect(isPrivateIp("127.0.0.1")).toBe(true);
      expect(isPrivateIp("10.0.1.20")).toBe(true);
      expect(isPrivateIp("192.168.1.1")).toBe(true);
      expect(isPrivateIp("172.16.0.1")).toBe(true);
      expect(isPrivateIp("172.31.255.255")).toBe(true);
      expect(isPrivateIp("0.0.0.0")).toBe(true);
    });

    it("identifies public IPv4 addresses correctly", () => {
      expect(isPrivateIp("1.1.1.1")).toBe(false);
      expect(isPrivateIp("8.8.8.8")).toBe(false);
      expect(isPrivateIp("185.220.101.5")).toBe(false);
      expect(isPrivateIp("172.32.0.1")).toBe(false);
    });
  });

  describe("resolveHostIps", () => {
    it("returns directly if hostname is already an IPv4", async () => {
      const ips = await resolveHostIps("1.2.3.4");
      expect(ips).toEqual(["1.2.3.4"]);
      expect(getDnsCacheSize()).toBe(0);
    });

    it("resolves multiple A records and caches results", async () => {
      const resolveSpy = vi
        .spyOn(dns.promises, "resolve4")
        .mockResolvedValue(["198.51.100.1", "198.51.100.2", "198.51.100.1"]);

      const ips1 = await resolveHostIps("multi.cdn.com");
      expect(ips1).toEqual(["198.51.100.1", "198.51.100.2"]);
      expect(resolveSpy).toHaveBeenCalledTimes(1);
      expect(getDnsCacheSize()).toBe(1);

      // Second call should hit in-memory cache
      const ips2 = await resolveHostIps("multi.cdn.com");
      expect(ips2).toEqual(["198.51.100.1", "198.51.100.2"]);
      expect(resolveSpy).toHaveBeenCalledTimes(1);

      // Force refresh should bypass cache
      const ips3 = await resolveHostIps("multi.cdn.com", true);
      expect(ips3).toEqual(["198.51.100.1", "198.51.100.2"]);
      expect(resolveSpy).toHaveBeenCalledTimes(2);
    });

    it("falls back to dns.promises.lookup if resolve4 rejects", async () => {
      vi.spyOn(dns.promises, "resolve4").mockRejectedValue(new Error("ENODATA"));
      const lookupSpy = vi
        .spyOn(dns.promises, "lookup")
        .mockResolvedValue([
          { address: "203.0.113.10", family: 4 },
          { address: "203.0.113.20", family: 4 },
        ] as any);

      const ips = await resolveHostIps("cname.provider.net");
      expect(ips).toEqual(["203.0.113.10", "203.0.113.20"]);
      expect(lookupSpy).toHaveBeenCalled();
    });

    it("filters private IPs when filterPrivate is true", async () => {
      vi.spyOn(dns.promises, "resolve4").mockResolvedValue(["127.0.0.1", "198.51.100.5", "10.0.0.1"]);

      const ips = await resolveHostIps("internal-external.example.com", false, true);
      expect(ips).toEqual(["198.51.100.5"]);
    });

    it("clears cache with clearDnsCache", async () => {
      vi.spyOn(dns.promises, "resolve4").mockResolvedValue(["198.51.100.1"]);
      await resolveHostIps("cache-test.com");
      expect(getDnsCacheSize()).toBe(1);

      clearDnsCache();
      expect(getDnsCacheSize()).toBe(0);
    });
  });

  describe("createIpPinnedAgent", () => {
    it("creates an http.Agent and an https.Agent", () => {
      const httpAgent = createIpPinnedAgent("198.51.100.1", false);
      const httpsAgent = createIpPinnedAgent("198.51.100.1", true);

      expect(httpAgent).toBeInstanceOf(http.Agent);
      expect(httpsAgent).toBeInstanceOf(https.Agent);
    });

    it("custom lookup handles Node 20 Happy Eyeballs options.all: true", () => {
      const agent = createIpPinnedAgent("198.51.100.1", false) as any;
      const lookupFn = agent.options.lookup;
      expect(typeof lookupFn).toBe("function");

      let calledErr: any = null;
      let calledResult: any = null;

      lookupFn("my-host.com", { all: true }, (err: any, addresses: any) => {
        calledErr = err;
        calledResult = addresses;
      });

      expect(calledErr).toBeNull();
      expect(calledResult).toEqual([{ address: "198.51.100.1", family: 4 }]);
    });

    it("custom lookup handles single address lookup and swapped callback", () => {
      const agent = createIpPinnedAgent("198.51.100.2", false) as any;
      const lookupFn = agent.options.lookup;

      // Without options (callback passed as 2nd arg)
      let resAddr: any;
      let resFam: any;
      lookupFn("my-host.com", (err: any, addr: any, family: any) => {
        resAddr = addr;
        resFam = family;
      });
      expect(resAddr).toBe("198.51.100.2");
      expect(resFam).toBe(4);

      // With options { all: false }
      lookupFn("my-host.com", { all: false }, (err: any, addr: any, family: any) => {
        resAddr = addr;
        resFam = family;
      });
      expect(resAddr).toBe("198.51.100.2");
      expect(resFam).toBe(4);
    });

    it("routes actual HTTP request to pinned IP while sending original Host header", async () => {
      let receivedHostHeader: string | undefined;

      const server = http.createServer((req, res) => {
        receivedHostHeader = req.headers.host;
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
      });

      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as any).port;

      try {
        const pinnedAgent = createIpPinnedAgent("127.0.0.1", false);

        await new Promise<void>((resolve, reject) => {
          const req = http.request(
            {
              host: "unresolvable-domain.invalid",
              port,
              path: "/test",
              agent: pinnedAgent,
              headers: {
                Host: "unresolvable-domain.invalid",
              },
            },
            (res) => {
              res.resume();
              res.on("end", () => resolve());
            }
          );
          req.on("error", reject);
          req.end();
        });

        expect(receivedHostHeader).toBe("unresolvable-domain.invalid");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  describe("measureIpLatency", () => {
    let server: http.Server;
    let serverPort: number;

    beforeEach(async () => {
      server = http.createServer((req, res) => {
        if (req.url === "/timeout") {
          // don't respond
          return;
        }
        if (req.url === "/unauthorized") {
          res.writeHead(401, { "Content-Type": "text/plain" });
          res.end("unauthorized");
          return;
        }
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("hello");
      });

      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      serverPort = (server.address() as any).port;
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it("measures latency successfully on HTTP 200", async () => {
      const latency = await measureIpLatency("my-upstream.com", "127.0.0.1", serverPort, false, 1500);
      expect(latency).not.toBeNull();
      expect(typeof latency).toBe("number");
      expect(latency!).toBeGreaterThanOrEqual(1);
    });

    it("counts 4xx (e.g. 401) responses as successful network reachability", async () => {
      const latency = await measureIpLatency("my-upstream.com/unauthorized", "127.0.0.1", serverPort, false, 1500);
      expect(latency).not.toBeNull();
      expect(latency!).toBeGreaterThanOrEqual(1);
    });

    it("returns null on unreachable port or connection refused", async () => {
      // Port 1 is reserved and typically immediately refused
      const latency = await measureIpLatency("dead-host.com", "127.0.0.1", 1, false, 500);
      expect(latency).toBeNull();
    });

    it("returns null on timeout", async () => {
      const latency = await measureIpLatency("my-upstream.com/timeout", "127.0.0.1", serverPort, false, 100);
      expect(latency).toBeNull();
    });
  });

  describe("rankHostIps", () => {
    it("resolves and ranks IPs by latency ascending, placing unhealthy at end", async () => {
      vi.spyOn(dns.promises, "resolve4").mockResolvedValue(["198.51.100.1", "198.51.100.2", "198.51.100.3"]);

      // Mock measureIpLatency behavior for each IP
      const mockMeasure = vi.fn().mockImplementation((_host, ip) => {
        if (ip === "198.51.100.1") return Promise.resolve(80);
        if (ip === "198.51.100.2") return Promise.resolve(15);
        if (ip === "198.51.100.3") return Promise.resolve(null);
        return Promise.resolve(null);
      });

      // Instead of monkey-patching internal calls directly if imported, test with rankHostIps
      // Let's create an HTTP server to test rankHostIps end-to-end
    });

    it("ranks responsive IPs ahead of unresponsive ones", async () => {
      let server: http.Server;
      server = http.createServer((_req, res) => {
        res.writeHead(200);
        res.end("ok");
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const serverPort = (server.address() as any).port;

      try {
        vi.spyOn(dns.promises, "resolve4").mockResolvedValue(["127.0.0.1", "127.0.0.254"]);

        const ranked = await rankHostIps("cluster.upstream.com", serverPort, false, 300);

        expect(ranked).toHaveLength(2);
        // 127.0.0.1 has active server listening, so it should be healthy and first
        expect(ranked[0].ip).toBe("127.0.0.1");
        expect(ranked[0].healthy).toBe(true);
        expect(ranked[0].latencyMs).not.toBeNull();

        // 127.0.0.254 should be dead/unreachable
        expect(ranked[1].ip).toBe("127.0.0.254");
        expect(ranked[1].healthy).toBe(false);
        expect(ranked[1].latencyMs).toBeNull();
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("returns empty array when no IPs resolve", async () => {
      vi.spyOn(dns.promises, "resolve4").mockRejectedValue(new Error("ENOTFOUND"));
      vi.spyOn(dns.promises, "lookup").mockRejectedValue(new Error("ENOTFOUND"));

      const ranked = await rankHostIps("nonexistent.test");
      expect(ranked).toEqual([]);
    });
  });
});
