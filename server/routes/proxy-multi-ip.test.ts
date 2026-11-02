import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { EventEmitter } from 'events';
import http from 'http';
import { connectDb, getDb } from '../db.ts';
import { playlists, sources } from '../schema.ts';
import { eq } from 'drizzle-orm';
import { streamHub } from '../multiplexer/stream-hub.ts';
import { proxyStats, streamControllers } from '../proxy-stats.ts';
import * as dnsResolver from '../dns-resolver.ts';

const mockAxios = vi.fn();
vi.mock('axios', () => ({
  default: (...args: any[]) => mockAxios(...args),
}));

vi.mock('../logger.ts', () => ({
  log: vi.fn(),
}));

// Import createProxyRouter after mocks
import { createProxyRouter, sourceOutages } from './proxy.ts';

describe('Multi-IP Stream Proxying & Failover', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    process.env.SQLITE_PATH = ':memory:';
    process.env.GECKO_LIVE_BUFFER_SECONDS = '0';
    await connectDb();

    const db = getDb();
    db.delete(playlists).run();
    db.delete(sources).run();

    streamHub.reset();
    proxyStats.connections.clear();
    streamControllers.clear();
    proxyStats.activeStreams = 0;
    mockAxios.mockReset();
    sourceOutages.clear();

    const app = express();
    app.use('/', createProxyRouter());
    server = http.createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address() as any;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    delete process.env.GECKO_LIVE_BUFFER_SECONDS;
    streamHub.reset();
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  type AgentLookup = (
    hostname: string,
    options: object,
    callback: (err: NodeJS.ErrnoException | null, address: string, family?: number) => void
  ) => void;
  const isAgentLookup = (value: unknown): value is AgentLookup => typeof value === 'function';

  /** Returns the IP the agent's custom lookup pins `hostname` to ('' if it has none). */
  function inspectAgentIp(agent: unknown, hostname: string): string {
    let resolved = '';
    if (agent && typeof agent === 'object' && 'options' in agent) {
      const options: unknown = agent.options;
      if (options && typeof options === 'object' && 'lookup' in options && isAgentLookup(options.lookup)) {
        options.lookup(hostname, {}, (_err, address) => {
          resolved = typeof address === 'string' ? address : '';
        });
      }
    }
    return resolved;
  }

  it('fails over to second candidate IP when first candidate IP returns HTTP 500', async () => {
    const db = getDb();
    db.insert(playlists).values({
      id: 'pl-test',
      userId: 'user-1',
      name: 'Test Playlist',
      username: 'multiuser',
      password: 'multipass',
      sourceIds: ['src-multi'] as any,
      directStreams: false,
    }).run();

    db.insert(sources).values({
      id: 'src-multi',
      userId: 'user-1',
      name: 'Multi Host Source',
      type: 'xtream',
      url: 'http://multi-node.upstream.tv:8080',
      username: 'src_user',
      password: 'src_pass',
      autoSyncEnabled: false,
      extra: {
        hosts: [
          {
            url: 'http://multi-node.upstream.tv:8080',
            order: 0,
            uses: 0,
            failures: 0,
            resolvedIp: '198.51.100.10',
            ipCount: 2,
            resolvedIps: [
              { ip: '198.51.100.10', latencyMs: 20, healthy: true },
              { ip: '198.51.100.20', latencyMs: 35, healthy: true },
            ],
          },
        ],
      } as any,
    }).run();

    const fakeStreamSuccess = new EventEmitter();
    (fakeStreamSuccess as any).destroy = vi.fn();

    // Call 1 (IP 198.51.100.10) fails with 500
    // Call 2 (IP 198.51.100.20) succeeds with 200
    mockAxios
      .mockResolvedValueOnce({
        status: 500,
        data: { destroy: vi.fn() },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: fakeStreamSuccess,
        headers: { 'content-type': 'video/mp2t' },
        request: { setTimeout: vi.fn() },
      });

    const abortController = new AbortController();
    const dataTimer = setInterval(() => {
      fakeStreamSuccess.emit('data', Buffer.from('initial-chunk'));
    }, 20);
    try {
      const res = await fetch(`${baseUrl}/live/multiuser/multipass/100.ts`, { signal: abortController.signal });
      expect(res.status).toBe(200);

      // Verify Axios was called twice
      expect(mockAxios).toHaveBeenCalledTimes(2);

      const call1Config = mockAxios.mock.calls[0][0];
      const call2Config = mockAxios.mock.calls[1][0];

      expect(inspectAgentIp(call1Config.httpAgent, 'multi-node.upstream.tv')).toBe('198.51.100.10');
      expect(inspectAgentIp(call2Config.httpAgent, 'multi-node.upstream.tv')).toBe('198.51.100.20');

      // Verify streamHub registered channel with candidate IPs and correct index
      const channel = streamHub.getChannel('src-multi', '100');
      expect(channel).toBeDefined();
      expect(channel?.upstreamConfig?.candidateIps).toEqual(['198.51.100.10', '198.51.100.20']);
      expect(channel?.upstreamConfig?.currentIpIndex).toBe(1);
    } finally {
      clearInterval(dataTimer);
      abortController.abort();
    }
  });

  it('fails through all candidate IPs and returns error when all return 5xx', async () => {
    const db = getDb();
    db.insert(playlists).values({
      id: 'pl-fail',
      userId: 'user-1',
      name: 'Fail Playlist',
      username: 'failuser',
      password: 'failpass',
      sourceIds: ['src-fail'] as any,
      directStreams: false,
    }).run();

    db.insert(sources).values({
      id: 'src-fail',
      userId: 'user-1',
      name: 'Failing Multi Source',
      type: 'xtream',
      url: 'http://failing.upstream.tv:8080',
      username: 'src_user',
      password: 'src_pass',
      autoSyncEnabled: false,
      extra: {
        hosts: [
          {
            url: 'http://failing.upstream.tv:8080',
            order: 0,
            uses: 0,
            failures: 0,
            resolvedIp: '198.51.100.1',
            ipCount: 2,
            resolvedIps: [
              { ip: '198.51.100.1', latencyMs: 20, healthy: true },
              { ip: '198.51.100.2', latencyMs: 25, healthy: true },
            ],
          },
        ],
      } as any,
    }).run();

    mockAxios
      .mockResolvedValueOnce({
        status: 503,
        data: { destroy: vi.fn() },
      })
      .mockResolvedValueOnce({
        status: 500,
        data: { destroy: vi.fn() },
      });

    const res = await fetch(`${baseUrl}/live/failuser/failpass/101.ts`);
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toContain('All upstream sources failed');

    // Both candidate IPs were tried
    expect(mockAxios).toHaveBeenCalledTimes(2);
    expect(inspectAgentIp(mockAxios.mock.calls[0][0].httpAgent, 'failing.upstream.tv')).toBe('198.51.100.1');
    expect(inspectAgentIp(mockAxios.mock.calls[1][0].httpAgent, 'failing.upstream.tv')).toBe('198.51.100.2');
  });

  it('does not rotate IPs on HTTP 409 (account slot taken) and answers 503 + Retry-After', async () => {
    const db = getDb();
    db.insert(playlists).values({
      id: 'pl-slot',
      userId: 'user-1',
      name: 'Slot Playlist',
      username: 'slotuser',
      password: 'slotpass',
      sourceIds: ['src-slot'] as any,
      directStreams: false,
    }).run();

    db.insert(sources).values({
      id: 'src-slot',
      userId: 'user-1',
      name: 'Single Connection Source',
      type: 'xtream',
      url: 'http://slot.upstream.tv:8080',
      username: 'src_user',
      password: 'src_pass',
      autoSyncEnabled: false,
      extra: {
        hosts: [
          {
            url: 'http://slot.upstream.tv:8080',
            order: 0,
            uses: 0,
            failures: 0,
            resolvedIp: '203.0.113.1',
            ipCount: 2,
            resolvedIps: [
              { ip: '203.0.113.1', latencyMs: 20, healthy: true },
              { ip: '203.0.113.2', latencyMs: 25, healthy: true },
            ],
          },
        ],
      } as any,
    }).run();

    mockAxios.mockResolvedValueOnce({
      status: 409,
      data: { destroy: vi.fn() },
    });

    const res = await fetch(`${baseUrl}/live/slotuser/slotpass/102.ts`);
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
    const body = await res.text();
    expect(body).toContain('409');

    // The second candidate IP must NOT be tried: it would just steal the slot again
    // ("a newer request of the user took the slot first") and loop forever.
    expect(mockAxios).toHaveBeenCalledTimes(1);
  });

  it('skips the remaining edge IPs of a CDN host after a timeout', async () => {
    const db = getDb();
    db.insert(playlists).values({
      id: 'pl-cdn',
      userId: 'user-1',
      name: 'CDN Playlist',
      username: 'cdnuser',
      password: 'cdnpass',
      sourceIds: ['src-cdn'] as any,
      directStreams: false,
    }).run();

    db.insert(sources).values({
      id: 'src-cdn',
      userId: 'user-1',
      name: 'Cloudflare Source',
      type: 'xtream',
      url: 'http://cdn.upstream.tv:8080',
      username: 'src_user',
      password: 'src_pass',
      autoSyncEnabled: false,
      extra: {
        hosts: [
          {
            url: 'http://cdn.upstream.tv:8080',
            order: 0,
            uses: 0,
            failures: 0,
            networkType: 'cdn',
            cdnProvider: 'Cloudflare',
            resolvedIp: '104.16.0.1',
            ipCount: 2,
            resolvedIps: [
              { ip: '104.16.0.1', latencyMs: 20, healthy: true },
              { ip: '104.16.0.2', latencyMs: 25, healthy: true },
            ],
          },
        ],
      } as any,
    }).run();

    mockAxios.mockRejectedValueOnce({ code: 'ECONNABORTED', message: 'timeout of 15000ms exceeded' });

    const res = await fetch(`${baseUrl}/live/cdnuser/cdnpass/103.ts`);
    expect(res.status).toBe(504);

    // Both A records are edges of the same origin: retrying the second one only
    // spends another 15 s handshake timeout.
    expect(mockAxios).toHaveBeenCalledTimes(1);
  });

  it('dynamically resolves candidate IPs via resolveHostIps when not present in source extra', async () => {
    const resolveSpy = vi.spyOn(dnsResolver, 'resolveHostIps').mockResolvedValue(['203.0.113.50', '203.0.113.60']);

    const db = getDb();
    db.insert(playlists).values({
      id: 'pl-dyn',
      userId: 'user-1',
      name: 'Dynamic Playlist',
      username: 'dynuser',
      password: 'dynpass',
      sourceIds: ['src-dyn'] as any,
      directStreams: false,
    }).run();

    db.insert(sources).values({
      id: 'src-dyn',
      userId: 'user-1',
      name: 'Dynamic Source',
      type: 'xtream',
      url: 'http://dynamic.nodes.tv:8080',
      username: 'src_user',
      password: 'src_pass',
      autoSyncEnabled: false,
      extra: {
        hosts: [
          {
            url: 'http://dynamic.nodes.tv:8080',
            order: 0,
            uses: 0,
            failures: 0,
          },
        ],
      } as any,
    }).run();

    const fakeStream = new EventEmitter();
    (fakeStream as any).destroy = vi.fn();

    // Call 1 (203.0.113.50) fails with 502
    // Call 2 (203.0.113.60) succeeds with 200
    mockAxios
      .mockResolvedValueOnce({
        status: 502,
        data: { destroy: vi.fn() },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: fakeStream,
        headers: { 'content-type': 'video/mp2t' },
        request: { setTimeout: vi.fn() },
      });

    const abortController = new AbortController();
    setTimeout(() => {
      fakeStream.emit('data', Buffer.from('dyn-chunk'));
    }, 20);
    const res = await fetch(`${baseUrl}/live/dynuser/dynpass/200.ts`, { signal: abortController.signal });
    expect(res.status).toBe(200);

    expect(resolveSpy).toHaveBeenCalledWith('dynamic.nodes.tv');
    expect(mockAxios).toHaveBeenCalledTimes(2);
    expect(inspectAgentIp(mockAxios.mock.calls[0][0].httpAgent, 'dynamic.nodes.tv')).toBe('203.0.113.50');
    expect(inspectAgentIp(mockAxios.mock.calls[1][0].httpAgent, 'dynamic.nodes.tv')).toBe('203.0.113.60');

    abortController.abort();
    resolveSpy.mockRestore();
  });

  it('enriches candidateIps from DNS when host has only a single legacy resolvedIp', async () => {
    const resolveSpy = vi.spyOn(dnsResolver, 'resolveHostIps').mockResolvedValue(['198.51.100.10', '198.51.100.20', '198.51.100.30']);

    const db = getDb();
    db.insert(playlists).values({
      id: 'pl-single-legacy',
      userId: 'user-1',
      name: 'Single Legacy Playlist',
      username: 'legacyuser',
      password: 'legacypass',
      sourceIds: ['src-legacy'] as any,
      directStreams: false,
    }).run();

    db.insert(sources).values({
      id: 'src-legacy',
      userId: 'user-1',
      name: 'Legacy Single IP Source',
      type: 'xtream',
      url: 'http://legacy.nodes.tv:8080',
      username: 'src_user',
      password: 'src_pass',
      autoSyncEnabled: false,
      extra: {
        hosts: [
          {
            url: 'http://legacy.nodes.tv:8080',
            order: 0,
            uses: 0,
            failures: 0,
            resolvedIp: '198.51.100.10', // Single legacy IP, no resolvedIps array
          },
        ],
      } as any,
    }).run();

    const fakeStream = new EventEmitter();
    (fakeStream as any).destroy = vi.fn();

    // Call 1 (198.51.100.10) fails with 500
    // Call 2 (198.51.100.20) succeeds with 200
    mockAxios
      .mockResolvedValueOnce({
        status: 500,
        data: { destroy: vi.fn() },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: fakeStream,
        headers: { 'content-type': 'video/mp2t' },
        request: { setTimeout: vi.fn() },
      });

    const abortController = new AbortController();
    setTimeout(() => {
      fakeStream.emit('data', Buffer.from('legacy-chunk'));
    }, 20);

    const res = await fetch(`${baseUrl}/live/legacyuser/legacypass/300.ts`, { signal: abortController.signal });
    expect(res.status).toBe(200);

    // Verify resolveHostIps was called to enrich the single IP
    expect(resolveSpy).toHaveBeenCalledWith('legacy.nodes.tv');
    expect(mockAxios).toHaveBeenCalledTimes(2);

    const channel = streamHub.getChannel('src-legacy', '300');
    expect(channel).toBeDefined();
    expect(channel?.upstreamConfig?.candidateIps).toEqual(['198.51.100.10', '198.51.100.20', '198.51.100.30']);
    expect(channel?.upstreamConfig?.currentIpIndex).toBe(1);

    abortController.abort();
    resolveSpy.mockRestore();
  });

  it('re-resolves DNS and succeeds via a fresh IP when the pinned pool went stale', async () => {
    const db = getDb();
    db.insert(playlists).values({
      id: 'pl-stale',
      userId: 'user-1',
      name: 'Stale Pool Playlist',
      username: 'staleuser',
      password: 'stalepass',
      sourceIds: ['src-stale'] as any,
      directStreams: false,
    }).run();

    db.insert(sources).values({
      id: 'src-stale',
      userId: 'user-1',
      name: 'Stale Pool Source',
      type: 'xtream',
      url: 'http://stale.nodes.tv:8080',
      username: 'src_user',
      password: 'src_pass',
      autoSyncEnabled: false,
      extra: {
        hosts: [
          {
            url: 'http://stale.nodes.tv:8080',
            order: 0,
            uses: 0,
            failures: 0,
            resolvedIp: '198.51.100.10',
            ipCount: 2,
            resolvedIps: [
              { ip: '198.51.100.10', latencyMs: 20, healthy: true },
              { ip: '198.51.100.20', latencyMs: 35, healthy: true },
            ],
          },
        ],
      } as any,
    }).run();

    // Simulate the provider rotating its IP pool after the benchmark: every cached
    // IP hangs in the TLS handshake (Bun: "Socket is closed", no HTTP status).
    const resolveSpy = vi.spyOn(dnsResolver, 'resolveHostIps').mockResolvedValue(['203.0.113.77']);

    const fakeStream = new EventEmitter();
    (fakeStream as any).destroy = vi.fn();

    mockAxios
      .mockRejectedValueOnce(Object.assign(new Error('Socket is closed'), { code: undefined }))
      .mockResolvedValueOnce({
        status: 200,
        data: fakeStream,
        headers: { 'content-type': 'video/mp2t' },
        request: { setTimeout: vi.fn() },
      });

    const abortController = new AbortController();
    const dataTimer = setInterval(() => {
      fakeStream.emit('data', Buffer.from('fresh-pool-chunk'));
    }, 20);
    try {
      const res = await fetch(`${baseUrl}/live/staleuser/stalepass/400.ts`, { signal: abortController.signal });
      expect(res.status).toBe(200);

      // DNS was re-checked with forceRefresh after the connection-class failure
      expect(resolveSpy).toHaveBeenCalledWith('stale.nodes.tv', true);

      // First call pinned the stale IP, second call the freshly resolved one
      expect(mockAxios).toHaveBeenCalledTimes(2);
      expect(inspectAgentIp(mockAxios.mock.calls[0][0].httpAgent, 'stale.nodes.tv')).toBe('198.51.100.10');
      expect(inspectAgentIp(mockAxios.mock.calls[1][0].httpAgent, 'stale.nodes.tv')).toBe('203.0.113.77');

      // The refreshed pool was persisted into sources.extra.hosts
      const doc = db.select().from(sources).where(eq(sources.id, 'src-stale')).get();
      const storedHosts = (doc?.extra as any).hosts as Array<any>;
      const stored = storedHosts[0];
      expect(stored.resolvedIp).toBe('203.0.113.77');
      expect(stored.resolvedIps[0].ip).toBe('203.0.113.77');
      expect(stored.resolvedIps.map((r: any) => r.ip)).toContain('198.51.100.10');
    } finally {
      clearInterval(dataTimer);
      abortController.abort();
      resolveSpy.mockRestore();
    }
  });

  it('does not re-resolve DNS for HTTP status errors (answers from a living host)', async () => {
    const db = getDb();
    db.insert(playlists).values({
      id: 'pl-status',
      userId: 'user-1',
      name: 'Status Fail Playlist',
      username: 'statususer',
      password: 'statuspass',
      sourceIds: ['src-status'] as any,
      directStreams: false,
    }).run();

    db.insert(sources).values({
      id: 'src-status',
      userId: 'user-1',
      name: 'Status Fail Source',
      type: 'xtream',
      url: 'http://status.nodes.tv:8080',
      username: 'src_user',
      password: 'src_pass',
      autoSyncEnabled: false,
      extra: {
        hosts: [
          {
            url: 'http://status.nodes.tv:8080',
            order: 0,
            uses: 0,
            failures: 0,
            resolvedIp: '198.51.100.10',
            ipCount: 2,
            resolvedIps: [
              { ip: '198.51.100.10', latencyMs: 20, healthy: true },
              { ip: '198.51.100.20', latencyMs: 35, healthy: true },
            ],
          },
        ],
      } as any,
    }).run();

    const resolveSpy = vi.spyOn(dnsResolver, 'resolveHostIps').mockResolvedValue(['203.0.113.99']);
    mockAxios
      .mockResolvedValueOnce({ status: 503, data: { destroy: vi.fn() } })
      .mockResolvedValueOnce({ status: 500, data: { destroy: vi.fn() } });

    const res = await fetch(`${baseUrl}/live/statususer/statuspass/500.ts`);
    expect(res.status).toBe(500);

    // Both stored candidates were tried and no DNS refresh happened: HTTP status
    // errors mean the host is alive — its DNS entry still points there.
    expect(mockAxios).toHaveBeenCalledTimes(2);
    expect(resolveSpy).not.toHaveBeenCalled();
    resolveSpy.mockRestore();
  });

  it('answers with 503 + Retry-After during the outage cooldown after transport-level failures', async () => {
    const db = getDb();
    db.insert(playlists).values({
      id: 'pl-outage',
      userId: 'user-1',
      name: 'Outage Playlist',
      username: 'outageuser',
      password: 'outagepass',
      sourceIds: ['src-outage'] as any,
      directStreams: false,
    }).run();

    db.insert(sources).values({
      id: 'src-outage',
      userId: 'user-1',
      name: 'Outage Source',
      type: 'xtream',
      url: 'http://dead.provider.tv:8080',
      username: 'src_user',
      password: 'src_pass',
      autoSyncEnabled: false,
      extra: {
        hosts: [
          {
            url: 'http://dead.provider.tv:8080',
            order: 0,
            uses: 0,
            failures: 0,
            resolvedIp: '198.51.100.10',
            ipCount: 2,
            resolvedIps: [
              { ip: '198.51.100.10', latencyMs: 20, healthy: true },
              { ip: '198.51.100.20', latencyMs: 35, healthy: true },
            ],
          },
        ],
      } as any,
    }).run();

    const failConn = Object.assign(new Error('Socket is closed'), { code: undefined });
    mockAxios
      .mockRejectedValueOnce(failConn)
      .mockRejectedValueOnce(failConn);

    const res1 = await fetch(`${baseUrl}/live/outageuser/outagepass/600.ts`);
    expect(res1.status).toBe(502);
    expect(await res1.text()).toContain('All upstream sources failed');
    expect(mockAxios).toHaveBeenCalledTimes(2);

    // Within the cooldown window: answered locally, zero upstream attempts
    const res2 = await fetch(`${baseUrl}/live/outageuser/outagepass/600.ts`);
    expect(res2.status).toBe(503);
    expect(res2.headers.get('retry-after')).toBeTruthy();
    expect(await res2.text()).toContain('momentarily down');
    expect(mockAxios).toHaveBeenCalledTimes(2);

    sourceOutages.clear();
  });
});
