import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { EventEmitter } from 'events';
import http from 'http';
import { connectDb, getDb } from '../db.ts';
import { playlists, sources } from '../schema.ts';
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
import { createProxyRouter } from './proxy.ts';

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

  function inspectAgentIp(agent: any): string {
    let resolved = '';
    if (agent?.options?.lookup) {
      agent.options.lookup('dummy.host', {}, (_err: any, address: string) => {
        resolved = address;
      });
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
    setTimeout(() => {
      fakeStreamSuccess.emit('data', Buffer.from('initial-chunk'));
    }, 20);
    const res = await fetch(`${baseUrl}/live/multiuser/multipass/100.ts`, { signal: abortController.signal });
    expect(res.status).toBe(200);

    // Verify Axios was called twice
    expect(mockAxios).toHaveBeenCalledTimes(2);

    const call1Config = mockAxios.mock.calls[0][0];
    const call2Config = mockAxios.mock.calls[1][0];

    expect(inspectAgentIp(call1Config.httpAgent)).toBe('198.51.100.10');
    expect(inspectAgentIp(call2Config.httpAgent)).toBe('198.51.100.20');

    // Verify streamHub registered channel with candidate IPs and correct index
    const channel = streamHub.getChannel('src-multi', '100');
    expect(channel).toBeDefined();
    expect(channel?.upstreamConfig?.candidateIps).toEqual(['198.51.100.10', '198.51.100.20']);
    expect(channel?.upstreamConfig?.currentIpIndex).toBe(1);

    abortController.abort();
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
    expect(inspectAgentIp(mockAxios.mock.calls[0][0].httpAgent)).toBe('198.51.100.1');
    expect(inspectAgentIp(mockAxios.mock.calls[1][0].httpAgent)).toBe('198.51.100.2');
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
    expect(inspectAgentIp(mockAxios.mock.calls[0][0].httpAgent)).toBe('203.0.113.50');
    expect(inspectAgentIp(mockAxios.mock.calls[1][0].httpAgent)).toBe('203.0.113.60');

    abortController.abort();
    resolveSpy.mockRestore();
  });
});
