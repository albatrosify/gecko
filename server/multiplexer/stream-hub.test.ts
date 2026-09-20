import { describe, it, expect, vi, beforeEach } from 'vitest';
import { streamHub } from './stream-hub.ts';
import { proxyStats } from '../proxy-stats.ts';
import { EventEmitter } from 'events';

vi.mock('../logger.ts', () => ({
  log: vi.fn(),
}));

describe('StreamHub', () => {
  beforeEach(() => {
    streamHub.reset();
    proxyStats.connections.clear();
    proxyStats.activeStreams = 0;
  });

  it('registers a channel and broadcasts chunks to multiple subscribers', () => {
    const fakeDataStream = new EventEmitter();
    (fakeDataStream as any).destroy = vi.fn();
    const fakeUpstreamResponse = { data: fakeDataStream };

    const channel = streamHub.registerChannel(
      'source-1',
      '100',
      'Das Erste HD',
      'live',
      'http://upstream.tv',
      fakeUpstreamResponse
    );

    expect(streamHub.hasChannel('source-1', '100')).toBe(true);

    // Create 2 mock subscribers
    const sub1Res: any = new EventEmitter();
    sub1Res.write = vi.fn();
    sub1Res.setHeader = vi.fn();

    const sub2Res: any = new EventEmitter();
    sub2Res.write = vi.fn();
    sub2Res.setHeader = vi.fn();

    streamHub.addSubscriber(channel.channelKey, {
      id: 'sub-1',
      res: sub1Res,
      username: 'user1',
      playlistName: 'Living Room',
      ip: '192.168.1.10',
      startTime: Date.now(),
    });

    streamHub.addSubscriber(channel.channelKey, {
      id: 'sub-2',
      res: sub2Res,
      username: 'user2',
      playlistName: 'Bedroom',
      ip: '192.168.1.20',
      startTime: Date.now(),
    });

    expect(channel.subscribers.size).toBe(2);

    // Emit chunk from upstream
    const testChunk = Buffer.from('hello-mpegts-chunk');
    fakeDataStream.emit('data', testChunk);

    expect(sub1Res.write).toHaveBeenCalledWith(testChunk);
    expect(sub2Res.write).toHaveBeenCalledWith(testChunk);
    expect(channel.bytesRead).toBe(testChunk.length);
  });

  it('unsubscribes a client and keeps stream alive if another client is watching', async () => {
    const fakeDataStream = new EventEmitter();
    (fakeDataStream as any).destroy = vi.fn();
    const fakeUpstreamResponse = { data: fakeDataStream };

    const channel = streamHub.registerChannel(
      'source-1',
      '100',
      'Das Erste HD',
      'live',
      'http://upstream.tv',
      fakeUpstreamResponse
    );

    const sub1Res: any = new EventEmitter();
    sub1Res.setHeader = vi.fn();
    const sub2Res: any = new EventEmitter();
    sub2Res.setHeader = vi.fn();

    streamHub.addSubscriber(channel.channelKey, {
      id: 'sub-1',
      res: sub1Res,
      username: 'user1',
      playlistName: 'Living Room',
      ip: '192.168.1.10',
      startTime: Date.now(),
    });

    streamHub.addSubscriber(channel.channelKey, {
      id: 'sub-2',
      res: sub2Res,
      username: 'user2',
      playlistName: 'Bedroom',
      ip: '192.168.1.20',
      startTime: Date.now(),
    });

    expect(channel.subscribers.size).toBe(2);

    // Sub 1 disconnects
    await streamHub.removeSubscriber(channel.channelKey, 'sub-1');
    expect(channel.subscribers.size).toBe(1);
    expect(streamHub.hasChannel('source-1', '100')).toBe(true);
    expect((fakeDataStream as any).destroy).not.toHaveBeenCalled();

    // Sub 2 disconnects -> channel tears down
    await streamHub.removeSubscriber(channel.channelKey, 'sub-2');
    expect(streamHub.hasChannel('source-1', '100')).toBe(false);
    expect((fakeDataStream as any).destroy).toHaveBeenCalled();
  });

  it('forwards chunks to DVR when attached and handles DVR handover and detach', async () => {
    const fakeDataStream = new EventEmitter();
    (fakeDataStream as any).destroy = vi.fn();
    const fakeUpstreamResponse = { data: fakeDataStream };

    const channel = streamHub.registerChannel(
      'source-dvr',
      '200',
      'ZDF HD',
      'live',
      'http://upstream.tv',
      fakeUpstreamResponse
    );

    const sub1Res: any = new EventEmitter();
    sub1Res.write = vi.fn();
    sub1Res.setHeader = vi.fn();

    streamHub.addSubscriber(channel.channelKey, {
      id: 'sub-dvr-1',
      res: sub1Res,
      username: 'user1',
      playlistName: 'Living Room',
      ip: '192.168.1.10',
      startTime: Date.now(),
    });

    const chunkCb = vi.fn();
    streamHub.setOnChunk(chunkCb);

    // Attach DVR
    const attached = streamHub.attachDvr('source-dvr', '200', 'rec-999');
    expect(attached).toBe(true);
    expect(channel.dvrRecordingId).toBe('rec-999');

    // Emit chunk -> both subscriber and DVR chunk callback should receive it
    const testChunk = Buffer.from('chunk-for-both');
    fakeDataStream.emit('data', testChunk);
    expect(sub1Res.write).toHaveBeenCalledWith(testChunk);
    expect(chunkCb).toHaveBeenCalledWith(channel.channelKey, testChunk);

    // Human subscriber disconnects, but DVR is recording -> Stream kept alive (not destroyed)!
    await streamHub.removeSubscriber(channel.channelKey, 'sub-dvr-1');
    expect(channel.subscribers.size).toBe(0);
    expect(streamHub.hasChannel('source-dvr', '200')).toBe(true);
    expect((fakeDataStream as any).destroy).not.toHaveBeenCalled();

    // Detach DVR -> Stream is now destroyed because 0 viewers and 0 DVR remain
    streamHub.detachDvr('source-dvr', '200');
    expect(streamHub.hasChannel('source-dvr', '200')).toBe(false);
    expect((fakeDataStream as any).destroy).toHaveBeenCalled();
  });

  it('does not evict newly joined subscriber with 1MB+ buffer during startup grace', () => {
    const fakeDataStream = new EventEmitter();
    (fakeDataStream as any).destroy = vi.fn();
    const fakeUpstreamResponse = { data: fakeDataStream };

    const channel = streamHub.registerChannel(
      'source-grace',
      '300',
      'La Sexta',
      'live',
      'http://upstream.tv',
      fakeUpstreamResponse
    );

    const subRes: any = new EventEmitter();
    subRes.setHeader = vi.fn();
    subRes.destroy = vi.fn();
    // Simulate write returning false and buffer having 1031 KB (the exact user log condition)
    subRes.writableLength = 1031 * 1024;
    subRes.write = vi.fn().mockReturnValue(false);

    streamHub.addSubscriber(channel.channelKey, {
      id: 'sub-tivimate',
      res: subRes,
      username: 'tv-user',
      playlistName: 'Living Room TV',
      ip: '192.168.100.41',
      startTime: Date.now(), // newly joined
    });

    expect(channel.subscribers.size).toBe(1);

    // Incoming chunk from upstream
    fakeDataStream.emit('data', Buffer.from('test-video-chunk'));

    // Should NOT be evicted
    expect(channel.subscribers.has('sub-tivimate')).toBe(true);
    expect(subRes.destroy).not.toHaveBeenCalled();
    expect(streamHub.hasChannel('source-grace', '300')).toBe(true);
  });

  it('evicts subscriber if buffer exceeds limit and sustains stall for >15s after startup grace', () => {
    const fakeDataStream = new EventEmitter();
    (fakeDataStream as any).destroy = vi.fn();
    const fakeUpstreamResponse = { data: fakeDataStream };

    const channel = streamHub.registerChannel(
      'source-stall',
      '400',
      'Stall Channel',
      'live',
      'http://upstream.tv',
      fakeUpstreamResponse
    );

    const subRes: any = new EventEmitter();
    subRes.setHeader = vi.fn();
    subRes.destroy = vi.fn();
    // Buffer exceeds soft threshold (16 MB)
    subRes.writableLength = 20 * 1024 * 1024;
    subRes.write = vi.fn().mockReturnValue(false);

    // Subscriber joined 30s ago (past 15s startup grace)
    const thirtySecAgo = Date.now() - 30_000;
    streamHub.addSubscriber(channel.channelKey, {
      id: 'sub-stalled',
      res: subRes,
      username: 'stalled-user',
      playlistName: 'TV',
      ip: '192.168.1.50',
      startTime: thirtySecAgo,
    });

    // First chunk marks subscriber as stalled
    fakeDataStream.emit('data', Buffer.from('chunk-1'));
    const sub = channel.subscribers.get('sub-stalled');
    expect(sub?.stalledSince).toBeDefined();
    expect(channel.subscribers.has('sub-stalled')).toBe(true);

    // Fast-forward stalledSince by 16s (exceeds 15s MAX_STALL_MS)
    if (sub) {
      sub.stalledSince = Date.now() - 16_000;
    }

    // Next chunk triggers eviction
    fakeDataStream.emit('data', Buffer.from('chunk-2'));
    expect(channel.subscribers.has('sub-stalled')).toBe(false);
    expect(subRes.destroy).toHaveBeenCalled();
  });
});


