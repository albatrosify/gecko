import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { streamHub } from './stream-hub.ts';
import { proxyStats, streamControllers, killStream } from '../proxy-stats.ts';
import { EventEmitter } from 'events';

vi.mock('../logger.ts', () => ({
  log: vi.fn(),
}));

describe('StreamHub', () => {
  beforeEach(() => {
    // Chunks are no longer forwarded the instant they arrive: the jitter buffer
    // holds content back and releases it on its pump interval. Fake timers let
    // tests drive that interval deterministically.
    vi.useFakeTimers();
    // The jitter buffer's pacing turns unit tests into timing puzzles; disable it so
    // chunk delivery stays deterministic and the pump is driven explicitly.
    process.env.GECKO_LIVE_BUFFER_SECONDS = '0';
    streamHub.reset();
    proxyStats.connections.clear();
    streamControllers.clear();
    proxyStats.activeStreams = 0;
  });

  afterEach(() => {
    delete process.env.GECKO_LIVE_BUFFER_SECONDS;
    vi.useRealTimers();
  });

  /** Advance past the jitter buffer's lead time so queued chunks become due. */
  const pumpOnce = () => vi.advanceTimersByTime(9_000);

  it('registers a channel and broadcasts chunks to multiple subscribers', async () => {
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
    pumpOnce();

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
    pumpOnce();
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
    pumpOnce();
    const sub = channel.subscribers.get('sub-stalled');
    expect(sub?.stalledSince).toBeDefined();
    expect(channel.subscribers.has('sub-stalled')).toBe(true);

    // Fast-forward stalledSince by 16s (exceeds 15s MAX_STALL_MS)
    if (sub) {
      sub.stalledSince = Date.now() - 16_000;
    }

    // Next chunk triggers eviction
    fakeDataStream.emit('data', Buffer.from('chunk-2'));
    pumpOnce();
    expect(channel.subscribers.has('sub-stalled')).toBe(false);
    expect(subRes.destroy).toHaveBeenCalled();
  });

  it('killStream force-quits a ghost subscriber and tears down the lone upstream', async () => {
    const fakeDataStream = new EventEmitter();
    (fakeDataStream as any).destroy = vi.fn();

    const channel = streamHub.registerChannel(
      'source-1',
      '100',
      'Ghost Stream',
      'live',
      'http://upstream.tv',
      { data: fakeDataStream }
    );

    const res: any = new EventEmitter();
    res.setHeader = vi.fn();
    res.destroy = vi.fn();
    res.writableEnded = false;
    res.destroyed = false;

    streamHub.addSubscriber(channel.channelKey, {
      id: 'sub-ghost',
      res,
      username: 'user1',
      playlistName: 'Living Room',
      ip: '192.168.1.10',
      startTime: Date.now(),
    });

    expect(proxyStats.connections.has('sub-ghost')).toBe(true);

    // The dashboard "Trennen" button path. removeSubscriber() performs its
    // non-DVR teardown synchronously (its only await lives in the DVR branch),
    // so no timer is needed here.
    expect(killStream('sub-ghost')).toBe(true);
    await vi.waitFor(() => expect(streamHub.hasChannel('source-1', '100')).toBe(false));

    expect(proxyStats.connections.has('sub-ghost')).toBe(false);
    expect(streamHub.hasChannel('source-1', '100')).toBe(false);
    expect((fakeDataStream as any).destroy).toHaveBeenCalled();
    expect(killStream('sub-ghost')).toBe(false);
  });

  it('performs seamless in-place reconnect on upstream silence or disconnect', async () => {
    const fakeDataStream1 = new EventEmitter();
    (fakeDataStream1 as any).destroy = vi.fn();

    const fakeDataStream2 = new EventEmitter();
    (fakeDataStream2 as any).destroy = vi.fn();

    const mockAxios = vi.fn().mockResolvedValue({
      status: 200,
      data: fakeDataStream2,
      request: { setTimeout: vi.fn() },
    });

    vi.doMock('axios', () => ({
      default: mockAxios,
    }));

    const channel = streamHub.registerChannel(
      'source-1',
      '100',
      'Das Erste HD',
      'live',
      'http://upstream.tv',
      { data: fakeDataStream1 },
      undefined,
      { url: 'http://upstream.tv/live/user/pass/100.ts' }
    );

    const subRes: any = new EventEmitter();
    subRes.write = vi.fn();
    subRes.setHeader = vi.fn();
    subRes.destroy = vi.fn();

    streamHub.addSubscriber(channel.channelKey, {
      id: 'sub-seamless',
      res: subRes,
      username: 'moritz',
      playlistName: 'Living Room',
      ip: '192.168.1.10',
      startTime: Date.now(),
    });

    // Chunk from stream 1
    fakeDataStream1.emit('data', Buffer.from('chunk1'));
    pumpOnce();
    expect(subRes.write).toHaveBeenCalledWith(Buffer.from('chunk1'));

    // Trigger reconnect
    const reconnected = await streamHub.reconnectChannel(channel.channelKey, 'test reconnect');
    expect(reconnected).toBe(true);

    // Old stream was destroyed
    expect((fakeDataStream1 as any).destroy).toHaveBeenCalled();

    // Subscriber was NOT destroyed
    expect(subRes.destroy).not.toHaveBeenCalled();
    expect(channel.subscribers.size).toBe(1);

    // New chunk from stream 2 reaches the same subscriber!
    fakeDataStream2.emit('data', Buffer.from('chunk2'));
    pumpOnce();
    expect(subRes.write).toHaveBeenCalledWith(Buffer.from('chunk2'));
  });

  it('rotates candidate IPs across reconnect attempts', async () => {
    const fakeDataStream1 = new EventEmitter();
    (fakeDataStream1 as any).destroy = vi.fn();

    const fakeDataStream2 = new EventEmitter();
    (fakeDataStream2 as any).destroy = vi.fn();

    const fakeDataStream3 = new EventEmitter();
    (fakeDataStream3 as any).destroy = vi.fn();

    let callCount = 0;
    const axiosCalls: any[] = [];
    const mockAxios = vi.fn().mockImplementation((config: any) => {
      axiosCalls.push(config);
      callCount++;
      return Promise.resolve({
        status: 200,
        data: callCount === 1 ? fakeDataStream2 : fakeDataStream3,
        request: { setTimeout: vi.fn() },
      });
    });

    vi.doMock('axios', () => ({
      default: mockAxios,
    }));

    const candidateIps = ['198.51.100.1', '198.51.100.2', '198.51.100.3'];

    const channel = streamHub.registerChannel(
      'source-multi',
      '200',
      'Multi IP Channel',
      'live',
      'http://multi-ip.tv',
      { data: fakeDataStream1 },
      undefined,
      {
        url: 'http://multi-ip.tv/live/user/pass/200.ts',
        candidateIps,
        currentIpIndex: 0,
      }
    );

    const subRes: any = new EventEmitter();
    subRes.write = vi.fn();
    subRes.setHeader = vi.fn();
    subRes.destroy = vi.fn();

    streamHub.addSubscriber(channel.channelKey, {
      id: 'sub-multi-ip',
      res: subRes,
      username: 'multi-user',
      playlistName: 'Living Room',
      ip: '192.168.1.10',
      startTime: Date.now(),
    });

    // First reconnect should rotate from index 0 -> index 1 ('198.51.100.2')
    const reconnected1 = await streamHub.reconnectChannel(channel.channelKey, 'gap test 1');
    expect(reconnected1).toBe(true);
    expect(channel.upstreamConfig?.currentIpIndex).toBe(1);
    expect(axiosCalls[0].httpAgent).toBeDefined();

    // Verify pinned agent lookup points to candidate IP index 1
    const agent1 = axiosCalls[0].httpAgent;
    let resolvedIp1 = '';
    agent1.options.lookup('multi-ip.tv', {}, (err: any, addr: string) => {
      resolvedIp1 = addr;
    });
    expect(resolvedIp1).toBe('198.51.100.2');

    // Second reconnect should rotate from index 1 -> index 2 ('198.51.100.3')
    const reconnected2 = await streamHub.reconnectChannel(channel.channelKey, 'gap test 2');
    expect(reconnected2).toBe(true);
    expect(channel.upstreamConfig?.currentIpIndex).toBe(2);

    const agent2 = axiosCalls[1].httpAgent;
    let resolvedIp2 = '';
    agent2.options.lookup('multi-ip.tv', {}, (err: any, addr: string) => {
      resolvedIp2 = addr;
    });
    expect(resolvedIp2).toBe('198.51.100.3');
  });
});


