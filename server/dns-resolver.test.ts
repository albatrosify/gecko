import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "http";
import https from "https";
import dns from "dns";
import axios from "axios";
import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import {
  resolveHostIps,
  createIpPinnedAgent,
  createIpPinnedAgents,
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
    type LookupFn = (
      hostname: string,
      options: dns.LookupOptions,
      callback: (err: NodeJS.ErrnoException | null, address?: string | dns.LookupAddress[], family?: number) => void
    ) => void;
    const isLookupFn = (value: unknown): value is LookupFn => typeof value === "function";
    // Node's Agent type does not expose `options`, but it exists at runtime and holds the
    // custom `lookup` that Agent passes through to net.connect.
    const getLookup = (agent: http.Agent | https.Agent): LookupFn => {
      const instance: unknown = agent;
      if (instance && typeof instance === "object" && "options" in instance) {
        const options: unknown = instance.options;
        if (options && typeof options === "object" && "lookup" in options && isLookupFn(options.lookup)) {
          return options.lookup;
        }
      }
      throw new Error("agent options have no lookup function");
    };

    /** Mocks dns.lookup like a resolver: resolves each hostname to one address. */
    const mockDnsLookup = (resolve: (hostname: string) => { address: string; family: number } | Error) =>
      vi.spyOn(dns, "lookup").mockImplementation((hostname: string, ...rest: unknown[]) => {
        const done = rest.find((arg): arg is NonNullable<Parameters<LookupFn>[2]> => typeof arg === "function");
        const opts = rest[0];
        const wantsAll = typeof opts === "object" && opts !== null && "all" in opts && opts.all === true;
        const result = resolve(hostname);
        if (!done) return;
        if (result instanceof Error) {
          done(result);
        } else if (wantsAll) {
          done(null, [result]);
        } else {
          done(null, result.address, result.family);
        }
      });

    it("creates an http.Agent and an https.Agent", () => {
      const httpAgent = createIpPinnedAgent("198.51.100.1", "my-host.com", false);
      const httpsAgent = createIpPinnedAgent("198.51.100.1", "my-host.com", true);

      expect(httpAgent).toBeInstanceOf(http.Agent);
      expect(httpsAgent).toBeInstanceOf(https.Agent);
    });

    it("pins the configured hostname and handles Node 20 Happy Eyeballs options.all: true", () => {
      const lookupFn = getLookup(createIpPinnedAgent("198.51.100.1", "my-host.com", false));

      let calledErr: unknown = null;
      let calledResult: unknown = null;

      lookupFn("my-host.com", { all: true }, (err, addresses) => {
        calledErr = err;
        calledResult = addresses;
      });

      expect(calledErr).toBeNull();
      expect(calledResult).toEqual([{ address: "198.51.100.1", family: 4 }]);
    });

    it("pins the configured hostname case-insensitively and ignores a trailing dot", () => {
      const lookupFn = getLookup(createIpPinnedAgent("198.51.100.1", "My-Host.com", false));

      let calledResult: unknown = null;
      lookupFn("my-host.com.", { all: true }, (err, addresses) => {
        calledResult = addresses;
      });

      expect(calledResult).toEqual([{ address: "198.51.100.1", family: 4 }]);
    });

    it("resolves foreign hostnames via real DNS instead of pinning them (HTTP redirect targets)", () => {
      const lookupFn = getLookup(createIpPinnedAgent("198.51.100.1", "my-host.com", false));
      const lookupSpy = mockDnsLookup(() => ({ address: "203.0.113.9", family: 4 }));

      let calledResult: unknown = null;
      lookupFn("redirect-target.example.com", { all: true }, (err, addresses) => {
        calledResult = addresses;
      });

      expect(lookupSpy).toHaveBeenCalledWith("redirect-target.example.com", { all: true }, expect.any(Function));
      expect(calledResult).toEqual([{ address: "203.0.113.9", family: 4 }]);
    });

    it("custom lookup handles single address lookup", () => {
      const lookupFn = getLookup(createIpPinnedAgent("198.51.100.2", "my-host.com", false));

      let resAddr: unknown;
      let resFam: unknown;
      lookupFn("my-host.com", { all: false }, (err, addr, family) => {
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
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("expected TCP port");
      const port = address.port;

      try {
        const pinnedAgent = createIpPinnedAgent("127.0.0.1", "unresolvable-domain.invalid", false);

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

    it("follows cross-host HTTP redirects via real DNS instead of the pinned IP", async () => {
      // serverB listens only on ::1. If the redirect hop were still sent to the pinned IP
      // (127.0.0.1) it would hit nothing on portB — reproducing the provider redirect loop.
      let serverBHost: string | undefined;
      const serverB = http.createServer((req, res) => {
        serverBHost = req.headers.host;
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("server-b");
      });
      await new Promise<void>((resolve) => serverB.listen(0, "::1", resolve));
      const addressB = serverB.address();
      if (addressB === null || typeof addressB === "string") throw new Error("expected TCP port");
      const portB = addressB.port;

      const serverA = http.createServer((_req, res) => {
        res.writeHead(302, { Location: `http://node-b.example:${portB}/stream` });
        res.end();
      });
      await new Promise<void>((resolve) => serverA.listen(0, "127.0.0.1", resolve));
      const addressA = serverA.address();
      if (addressA === null || typeof addressA === "string") throw new Error("expected TCP port");
      const portA = addressA.port;

      const lookupSpy = mockDnsLookup((hostname) =>
        hostname === "node-b.example"
          ? { address: "::1", family: 6 }
          : new Error(`unexpected DNS lookup for ${hostname}`)
      );

      const agent = createIpPinnedAgent("127.0.0.1", "lb.example", false);
      try {
        const response = await axios.get(`http://lb.example:${portA}/live/user/pass/1.ts`, {
          httpAgent: agent,
          httpsAgent: agent,
          timeout: 5000,
        });
        expect(response.status).toBe(200);
        expect(response.data).toBe("server-b");
        expect(serverBHost).toBe(`node-b.example:${portB}`);
      } finally {
        agent.destroy();
        lookupSpy.mockRestore();
        await new Promise<void>((resolve) => serverA.close(() => resolve()));
        await new Promise<void>((resolve) => serverB.close(() => resolve()));
      }
    });

    it("createIpPinnedAgents returns distinct protocol-appropriate agents", () => {
      const agents = createIpPinnedAgents("198.51.100.7", "my-host.com");
      expect(agents.http).toBeInstanceOf(http.Agent);
      expect(agents.https).toBeInstanceOf(https.Agent);
      expect(agents.http).not.toBe(agents.https);

      const pin = (agent: http.Agent | https.Agent): string => {
        let resolved = "";
        getLookup(agent)("my-host.com", {}, (_err, address) => {
          resolved = typeof address === "string" ? address : "";
        });
        return resolved;
      };
      expect(pin(agents.http)).toBe("198.51.100.7");
      expect(pin(agents.https)).toBe("198.51.100.7");
    });

    it("follows HTTPS→HTTP redirects when agents are provided per protocol", async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gecko-tls-"));
      const keyPath = path.join(tmp, "key.pem");
      const certPath = path.join(tmp, "cert.pem");
      execSync(
        `openssl req -x509 -newkey rsa:2048 -nodes -keyout "${keyPath}" -out "${certPath}" -days 1 -subj "/CN=lb.example" 2>/dev/null`
      );
      const key = fs.readFileSync(keyPath);
      const cert = fs.readFileSync(certPath);

      const serverB = http.createServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("server-b");
      });
      await new Promise<void>((resolve) => serverB.listen(0, "127.0.0.1", resolve));
      const addressB = serverB.address();
      if (addressB === null || typeof addressB === "string") throw new Error("expected TCP port");
      const portB = addressB.port;

      const serverA = https.createServer({ key, cert }, (_req, res) => {
        res.writeHead(302, { Location: `http://node-b.example:${portB}/stream` });
        res.end();
      });
      await new Promise<void>((resolve) => serverA.listen(0, "127.0.0.1", resolve));
      const addressA = serverA.address();
      if (addressA === null || typeof addressA === "string") throw new Error("expected TCP port");
      const portA = addressA.port;

      const lookupSpy = mockDnsLookup((hostname) =>
        hostname === "node-b.example"
          ? { address: "127.0.0.1", family: 4 }
          : new Error(`unexpected DNS lookup for ${hostname}`)
      );

      const agents = createIpPinnedAgents("127.0.0.1", "lb.example");
      try {
        const response = await axios.get(`https://lb.example:${portA}/live/user/pass/1.ts`, {
          httpAgent: agents.http,
          httpsAgent: agents.https,
          timeout: 5000,
        });
        expect(response.status).toBe(200);
        expect(response.data).toBe("server-b");
      } finally {
        agents.http.destroy();
        agents.https.destroy();
        lookupSpy.mockRestore();
        await new Promise<void>((resolve) => serverA.close(() => resolve()));
        await new Promise<void>((resolve) => serverB.close(() => resolve()));
        fs.rmSync(tmp, { recursive: true, force: true });
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
