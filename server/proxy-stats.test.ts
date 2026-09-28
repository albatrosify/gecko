import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  proxyStats,
  registerStreamController,
  unregisterStreamController,
  killStream,
  killAllStreams,
  getActiveVodConnectionsForSource,
  initProxyStatsInterval,
  stopProxyStatsInterval,
  streamControllers,
} from './proxy-stats.ts';

describe('proxy-stats', () => {
  beforeEach(() => {
    proxyStats.connections.clear();
    proxyStats.activeStreams = 0;
    streamControllers.clear();
  });

  afterEach(() => {
    stopProxyStatsInterval();
  });

  it('registers and kills a stream controller', () => {
    let killed = false;
    registerStreamController('c1', () => {
      killed = true;
    });

    expect(streamControllers.has('c1')).toBe(true);
    expect(killStream('c1')).toBe(true);
    expect(killed).toBe(true);
    expect(streamControllers.has('c1')).toBe(false);
    expect(killStream('c1')).toBe(false);
  });

  it('kills all streams with killAllStreams', () => {
    let k1 = false;
    let k2 = false;
    registerStreamController('c1', () => { k1 = true; });
    registerStreamController('c2', () => { k2 = true; });

    const count = killAllStreams();
    expect(count).toBe(2);
    expect(k1).toBe(true);
    expect(k2).toBe(true);
    expect(streamControllers.size).toBe(0);
  });

  it('getActiveVodConnectionsForSource correctly isolates 1:1 upstream connections', () => {
    // 1. Live subscriber (has channelKey) -> should NOT be included
    proxyStats.connections.set('sub1', {
      id: 'sub1',
      sourceId: 's1',
      channelKey: 's1:100',
      username: 'user1',
      streamId: '100',
      streamName: 'Live TV',
      playlistName: 'P1',
      type: 'live',
      ip: '1.2.3.4',
      startTime: Date.now(),
      bytesRead: 100,
      intervalBytes: 0,
      currentBps: 0,
      proxied: true,
    });

    // 2. Placeholder stream (isPlaceholder: true) -> should NOT be included
    proxyStats.connections.set('pl1', {
      id: 'pl1',
      sourceId: 's1',
      username: 'user2',
      streamId: '200',
      streamName: 'Blocked',
      playlistName: 'P1',
      type: 'live',
      ip: '1.2.3.4',
      startTime: Date.now(),
      bytesRead: 0,
      intervalBytes: 0,
      currentBps: 0,
      proxied: false,
      isPlaceholder: true,
    });

    // 3. VOD movie stream (1:1 proxied upstream) -> SHOULD be included
    proxyStats.connections.set('vod1', {
      id: 'vod1',
      sourceId: 's1',
      username: 'user3',
      streamId: '500',
      streamName: 'The Matrix',
      playlistName: 'P1',
      type: 'movie',
      ip: '1.2.3.5',
      startTime: Date.now(),
      bytesRead: 5000,
      intervalBytes: 0,
      currentBps: 0,
      proxied: true,
    });

    // 4. VOD on a different source -> should NOT be included for s1
    proxyStats.connections.set('vod2', {
      id: 'vod2',
      sourceId: 's2',
      username: 'user4',
      streamId: '600',
      streamName: 'Avatar',
      playlistName: 'P1',
      type: 'movie',
      ip: '1.2.3.6',
      startTime: Date.now(),
      bytesRead: 5000,
      intervalBytes: 0,
      currentBps: 0,
      proxied: true,
    });

    const activeVod = getActiveVodConnectionsForSource('s1');
    expect(activeVod).toHaveLength(1);
    expect(activeVod[0].id).toBe('vod1');
    expect(activeVod[0].streamName).toBe('The Matrix');
  });

  it('zombie sweeper purges orphan connections and dead sockets', () => {
    vi.useFakeTimers();
    initProxyStatsInterval();

    // Conn 1: Orphan (in proxyStats.connections but no controller)
    proxyStats.connections.set('orphan1', {
      id: 'orphan1',
      sourceId: 's1',
      username: 'user1',
      streamId: '10',
      streamName: 'Orphan',
      playlistName: 'P1',
      type: 'movie',
      ip: '1.1.1.1',
      startTime: Date.now(),
      bytesRead: 0,
      intervalBytes: 0,
      currentBps: 0,
      proxied: true,
    });
    proxyStats.activeStreams = 3;

    // Conn 2: Dead socket (isAlive returns false)
    let deadKilled = false;
    proxyStats.connections.set('dead1', {
      id: 'dead1',
      sourceId: 's1',
      username: 'user2',
      streamId: '20',
      streamName: 'Dead',
      playlistName: 'P1',
      type: 'movie',
      ip: '1.1.1.2',
      startTime: Date.now(),
      bytesRead: 0,
      intervalBytes: 0,
      currentBps: 0,
      proxied: true,
    });
    registerStreamController(
      'dead1',
      () => {
        deadKilled = true;
        proxyStats.connections.delete('dead1');
        proxyStats.activeStreams--;
      },
      () => false // dead!
    );

    // Conn 3: Healthy socket (isAlive returns true)
    proxyStats.connections.set('alive1', {
      id: 'alive1',
      sourceId: 's1',
      username: 'user3',
      streamId: '30',
      streamName: 'Alive',
      playlistName: 'P1',
      type: 'movie',
      ip: '1.1.1.3',
      startTime: Date.now(),
      bytesRead: 0,
      intervalBytes: 0,
      currentBps: 0,
      proxied: true,
    });
    registerStreamController(
      'alive1',
      () => {
        proxyStats.connections.delete('alive1');
        proxyStats.activeStreams--;
      },
      () => true // healthy
    );

    // Fast-forward 10 seconds (5 ticks of 2s) to trigger sweeper
    vi.advanceTimersByTime(10000);

    // Orphan should be deleted
    expect(proxyStats.connections.has('orphan1')).toBe(false);

    // Dead should have its kill callback invoked and be removed
    expect(deadKilled).toBe(true);
    expect(proxyStats.connections.has('dead1')).toBe(false);

    // Alive connection must stay untouched
    expect(proxyStats.connections.has('alive1')).toBe(true);

    vi.useRealTimers();
  });
});
