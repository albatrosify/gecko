import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkSourceConnection, getConnectionLogs, clearConnectionLogs } from './connection-monitor';
import { proxyStats } from './proxy-stats';
import { XtreamClient } from './xtream';
import { getDb, connectDb } from './db';
import { sources } from './schema';
import { eq } from 'drizzle-orm';
import { UpstreamSource } from '../src/types';

vi.mock('./logger', () => ({
  log: vi.fn()
}));

let mockAuthenticate = vi.fn();

vi.mock('./xtream', () => {
  return {
    XtreamClient: class {
      authenticate() {
        return mockAuthenticate();
      }
    }
  };
});

describe('Connection Monitor', () => {
  let db: any;

  beforeEach(async () => {
    process.env.SQLITE_PATH = ':memory:';
    db = await connectDb();
    proxyStats.connections.clear();
    vi.clearAllMocks();
  });

  it('should detect when 0 connections are in use (idle state)', async () => {
    const mockSource: UpstreamSource = {
      id: 'test-source-1',
      name: 'Test Provider',
      type: 'xtream',
      url: 'http://example.com:8080',
      username: 'user1',
      password: 'pass1',
      enabled: true,
      monitorEnabled: true
    };

    db.insert(sources).values({
      id: mockSource.id,
      userId: 'u1',
      name: mockSource.name,
      type: mockSource.type,
      url: mockSource.url,
      username: mockSource.username,
      password: mockSource.password,
      extra: { monitorEnabled: true }
    }).run();

    mockAuthenticate.mockResolvedValue({
      user_info: {
        auth: 1,
        status: 'Active',
        active_cons: '0',
        max_connections: '1',
        exp_date: '1774310400'
      }
    });

    const result = await checkSourceConnection(mockSource, true);

    expect(result.activeCons).toBe(0);
    expect(result.maxCons).toBe(1);
    expect(result.geckoStreams).toBe(0);
    expect(result.isExternal).toBe(false);
    expect(result.status).toBe('ok');

    const history = getConnectionLogs(mockSource.id);
    expect(history.length).toBe(1);
    expect(history[0].status).toBe('ok');
  });

  it('should detect when stream is active via Gecko proxy (legitimate local usage)', async () => {
    const mockSource: UpstreamSource = {
      id: 'test-source-2',
      name: 'Test Provider 2',
      type: 'xtream',
      url: 'http://example.com:8080',
      username: 'user2',
      password: 'pass2',
      enabled: true,
      monitorEnabled: true
    };

    db.insert(sources).values({
      id: mockSource.id,
      userId: 'u1',
      name: mockSource.name,
      type: mockSource.type,
      url: mockSource.url,
      username: mockSource.username,
      password: mockSource.password,
      extra: { monitorEnabled: true }
    }).run();

    // Register active stream in Gecko proxy
    proxyStats.connections.set('conn-1', {
      id: 'conn-1',
      sourceId: mockSource.id,
      username: 'client_user',
      streamId: '123',
      streamName: 'Channel 1',
      playlistName: 'Main',
      type: 'live',
      ip: '127.0.0.1',
      startTime: Date.now(),
      bytesRead: 1024,
      intervalBytes: 512,
      currentBps: 10000,
      proxied: true
    });

    mockAuthenticate.mockResolvedValue({
      user_info: {
        auth: 1,
        status: 'Active',
        active_cons: '1',
        max_connections: '1',
        exp_date: '1774310400'
      }
    });

    const result = await checkSourceConnection(mockSource, true);

    expect(result.activeCons).toBe(1);
    expect(result.maxCons).toBe(1);
    expect(result.geckoStreams).toBe(1);
    expect(result.isExternal).toBe(false);
    expect(result.status).toBe('ok');
  });

  it('should detect unauthorized external connection (intruder / external usage)', async () => {
    const mockSource: UpstreamSource = {
      id: 'test-source-3',
      name: 'Test Provider 3',
      type: 'xtream',
      url: 'http://example.com:8080',
      username: 'user3',
      password: 'pass3',
      enabled: true,
      monitorEnabled: true
    };

    db.insert(sources).values({
      id: mockSource.id,
      userId: 'u1',
      name: mockSource.name,
      type: mockSource.type,
      url: mockSource.url,
      username: mockSource.username,
      password: mockSource.password,
      extra: { monitorEnabled: true }
    }).run();

    // 0 active streams in Gecko, but upstream reports 1 active connection!
    mockAuthenticate.mockResolvedValue({
      user_info: {
        auth: 1,
        status: 'Active',
        active_cons: '1',
        max_connections: '1',
        exp_date: '1774310400'
      }
    });

    const result = await checkSourceConnection(mockSource, true);

    expect(result.activeCons).toBe(1);
    expect(result.maxCons).toBe(1);
    expect(result.geckoStreams).toBe(0);
    expect(result.isExternal).toBe(true);
    expect(result.status).toBe('external_activity');
    expect(result.details).toContain('1 external stream connection(s) detected');
  });

  it('should clear logs when clearConnectionLogs is called', async () => {
    const mockSource: UpstreamSource = {
      id: 'test-source-4',
      name: 'Test Provider 4',
      type: 'xtream',
      url: 'http://example.com:8080',
      username: 'user4',
      password: 'pass4',
      enabled: true,
      monitorEnabled: true
    };

    db.insert(sources).values({
      id: mockSource.id,
      userId: 'u1',
      name: mockSource.name,
      type: mockSource.type,
      url: mockSource.url,
      username: mockSource.username,
      password: mockSource.password,
      extra: { monitorEnabled: true }
    }).run();

    mockAuthenticate.mockResolvedValue({
      user_info: {
        auth: 1,
        status: 'Active',
        active_cons: '0',
        max_connections: '1'
      }
    });

    await checkSourceConnection(mockSource, true);
    expect(getConnectionLogs(mockSource.id).length).toBe(1);

    clearConnectionLogs(mockSource.id);
    expect(getConnectionLogs(mockSource.id).length).toBe(0);
  });
});
