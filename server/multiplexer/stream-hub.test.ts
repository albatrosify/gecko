import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { streamHub, computeBufferHealth, nextPaceTrim, LIVE_BUFFER_PACE_TRIM_MIN, LIVE_BUFFER_PACE_TRIM_MAX } from './stream-hub.ts';
import { proxyStats, streamControllers, killStream } from '../proxy-stats.ts';
import { EventEmitter } from 'events';

vi.mock('../logger.ts', () => ({
  log: vi.fn(),
}));

const pumpOnce = () => vi.advanceTimersByTime(9_000);

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

  it('hands buffer above the reserve to the client instead of pacing it out', async () => {
    // Smootheness over latency: the reserve is a floor that covers provider pauses,
    // everything above it belongs in the player's buffer.
    process.env.GECKO_LIVE_BUFFER_SECONDS = '4';

    const fakeDataStream = new EventEmitter();
    (fakeDataStream as any).destroy = vi.fn();
    const channel = streamHub.registerChannel(
      'source-burst', '200', 'Bursty', 'live', 'http://upstream.tv', { data: fakeDataStream }
    );

    const res: any = new EventEmitter();
    let released = 0;
    res.write = (buf: Buffer) => { released += buf.length; return true; };
    res.setHeader = vi.fn();

    streamHub.addSubscriber(channel.channelKey, {
      id: 'sub-surplus', res, username: 'u', playlistName: 'p', ip: '10.0.0.1', startTime: Date.now(),
    });

    // Establish a steady rate above the fallback (1 MB/s) so the reserve floor does
    // not kick in; 30 s of it dominates the rate window before the gulp below.
    for (let i = 0; i < 30; i++) {
      fakeDataStream.emit('data', Buffer.alloc(1_000_000, 1));
      vi.advanceTimersByTime(1_000);
    }

    // A 10 MB gulp against a ~4 MB (1 MB/s × 4 s) reserve leaves ~6 MB of surplus
    // that must reach the client in this tick, not over the next minutes.
    released = 0;
    fakeDataStream.emit('data', Buffer.alloc(10_000_000, 2));
    vi.advanceTimersByTime(50);

    expect(released).toBeGreaterThan(3_000_000);
    // The floor is kept: Gecko still holds the reserve for the next provider pause.
    expect(channel.bufferedBytes).toBeGreaterThan(0);
    expect(channel.bufferedBytes).toBeLessThan(8_000_000);
  });


  it('freezes the measured rate across an upstream silence instead of dropping to zero', async () => {
    process.env.GECKO_LIVE_BUFFER_SECONDS = '4';

    const fakeDataStream = new EventEmitter();
    (fakeDataStream as any).destroy = vi.fn();
    const channel = streamHub.registerChannel(
      'source-freeze', '500', 'Freeze Channel', 'live', 'http://upstream.tv', { data: fakeDataStream }
    );

    const res: any = new EventEmitter();
    res.write = vi.fn().mockReturnValue(true);
    res.setHeader = vi.fn();
    streamHub.addSubscriber(channel.channelKey, {
      id: 'sub-freeze', res, username: 'u', playlistName: 'p', ip: '10.0.0.1', startTime: Date.now(),
    });

    // Establish a ~10 KB/s arrival rate over 30 s.
    for (let i = 0; i < 30; i++) {
      fakeDataStream.emit('data', Buffer.alloc(10_000, 1));
      vi.advanceTimersByTime(1_000);
    }

    const before = streamHub.getBufferHealth(channel.channelKey)?.rateBps ?? 0;
    expect(before).toBeGreaterThan(0);

    // 15 s of silence (past the 12 s freeze threshold): the measured rate must not
    // collapse to zero, otherwise the pump would strand the buffered content.
    vi.advanceTimersByTime(15_000);
    const after = streamHub.getBufferHealth(channel.channelKey)?.rateBps ?? 0;

    expect(after).toBeGreaterThan(before * 0.5);
  });

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

    // The dashboard "Disconnect" button path. removeSubscriber() performs its
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

  // ── Per-category buffer override ──────────────────────────────────────────
  it('uses the per-channel buffer override instead of the global default', () => {
    process.env.GECKO_LIVE_BUFFER_SECONDS = '4';

    const fakeDataStream = new EventEmitter();
    (fakeDataStream as any).destroy = vi.fn();
    const channel = streamHub.registerChannel(
      'source-override', '600', 'Hockey', 'live', 'http://upstream.tv', { data: fakeDataStream },
      undefined, undefined, undefined, 12,
    );

    expect(channel.reserveSeconds).toBe(12);

    // The health gauge must report against the channel's own reserve, not the default.
    const res: any = new EventEmitter();
    res.write = vi.fn().mockReturnValue(true);
    res.setHeader = vi.fn();
    streamHub.addSubscriber(channel.channelKey, {
      id: 'sub-override', res, username: 'u', playlistName: 'p', ip: '10.0.0.1', startTime: Date.now(),
    });
    expect(streamHub.getBufferHealth(channel.channelKey)?.reserveSeconds).toBe(12);
  });

  it('falls back to the global default when no override is given', () => {
    process.env.GECKO_LIVE_BUFFER_SECONDS = '7';

    const fakeDataStream = new EventEmitter();
    (fakeDataStream as any).destroy = vi.fn();
    const channel = streamHub.registerChannel(
      'source-default', '601', 'News', 'live', 'http://upstream.tv', { data: fakeDataStream },
    );

    expect(channel.reserveSeconds).toBe(7);
  });

  it('forwards immediately when the category override turns buffering off', () => {
    process.env.GECKO_LIVE_BUFFER_SECONDS = '10';

    const fakeDataStream = new EventEmitter();
    (fakeDataStream as any).destroy = vi.fn();
    const channel = streamHub.registerChannel(
      'source-off', '602', 'Raw Feed', 'live', 'http://upstream.tv', { data: fakeDataStream },
      undefined, undefined, undefined, 0,
    );

    expect(channel.reserveSeconds).toBe(0);

    const res: any = new EventEmitter();
    let released = 0;
    res.write = (buf: Buffer) => { released += buf.length; return true; };
    res.setHeader = vi.fn();
    streamHub.addSubscriber(channel.channelKey, {
      id: 'sub-off', res, username: 'u', playlistName: 'p', ip: '10.0.0.1', startTime: Date.now(),
    });
    // No buffer health to report when pacing is off for this channel.
    expect(streamHub.getBufferHealth(channel.channelKey)).toBeNull();

    const payload = Buffer.alloc(1_000_000, 1);
    fakeDataStream.emit('data', payload);
    vi.advanceTimersByTime(50);

    // Passthrough: the client gets the chunk on the next pump, nothing is held back.
    expect(released).toBe(payload.length);
    expect(channel.bufferedBytes).toBe(0);
  });

  describe('Downstream TCP Backpressure Propagation', () => {
    it('pauses upstream stream when single subscriber socket is congested', () => {
      const fakeDataStream = new EventEmitter();
      (fakeDataStream as any).pause = vi.fn();
      (fakeDataStream as any).resume = vi.fn();
      (fakeDataStream as any).destroy = vi.fn();

      const channel = streamHub.registerChannel(
        'source-bp',
        '101',
        'Backpressure Test',
        'live',
        'http://upstream.tv',
        { data: fakeDataStream }
      );

      const res: any = new EventEmitter();
      res.setHeader = vi.fn();
      res.writableLength = 5 * 1024 * 1024; // > 4 MB limit
      res.write = vi.fn().mockReturnValue(false);

      streamHub.addSubscriber(channel.channelKey, {
        id: 'sub-bp-1',
        res,
        username: 'u',
        playlistName: 'p',
        ip: '10.0.0.1',
        startTime: Date.now(),
      });

      fakeDataStream.emit('data', Buffer.alloc(100_000, 1));
      pumpOnce();

      expect(channel.isUpstreamPaused).toBe(true);
      expect((fakeDataStream as any).pause).toHaveBeenCalled();
    });

    it('resumes upstream stream when subscriber socket drains', () => {
      const fakeDataStream = new EventEmitter();
      (fakeDataStream as any).pause = vi.fn();
      (fakeDataStream as any).resume = vi.fn();
      (fakeDataStream as any).destroy = vi.fn();

      const channel = streamHub.registerChannel(
        'source-bp',
        '102',
        'Backpressure Drain Test',
        'live',
        'http://upstream.tv',
        { data: fakeDataStream }
      );

      const res: any = new EventEmitter();
      res.setHeader = vi.fn();
      res.writableLength = 5 * 1024 * 1024;
      res.write = vi.fn().mockReturnValue(false);

      streamHub.addSubscriber(channel.channelKey, {
        id: 'sub-bp-2',
        res,
        username: 'u',
        playlistName: 'p',
        ip: '10.0.0.1',
        startTime: Date.now(),
      });

      fakeDataStream.emit('data', Buffer.alloc(100_000, 1));
      pumpOnce();
      expect(channel.isUpstreamPaused).toBe(true);

      // Client reads data, socket drains
      res.writableLength = 100_000; // < 4 MB
      res.emit('drain');

      expect(channel.isUpstreamPaused).toBe(false);
      expect((fakeDataStream as any).resume).toHaveBeenCalled();
    });

    it('does not pause upstream if multiple subscribers are watching', () => {
      const fakeDataStream = new EventEmitter();
      (fakeDataStream as any).pause = vi.fn();
      (fakeDataStream as any).resume = vi.fn();
      (fakeDataStream as any).destroy = vi.fn();

      const channel = streamHub.registerChannel(
        'source-bp',
        '103',
        'Multi-subscriber Backpressure Test',
        'live',
        'http://upstream.tv',
        { data: fakeDataStream }
      );

      const res1: any = new EventEmitter();
      res1.setHeader = vi.fn();
      res1.writableLength = 5 * 1024 * 1024; // sub 1 full
      res1.write = vi.fn().mockReturnValue(false);

      const res2: any = new EventEmitter();
      res2.setHeader = vi.fn();
      res2.writableLength = 10_000; // sub 2 healthy
      res2.write = vi.fn().mockReturnValue(true);

      streamHub.addSubscriber(channel.channelKey, {
        id: 'sub-bp-3a', res: res1, username: 'u1', playlistName: 'p', ip: '10.0.0.1', startTime: Date.now(),
      });
      streamHub.addSubscriber(channel.channelKey, {
        id: 'sub-bp-3b', res: res2, username: 'u2', playlistName: 'p', ip: '10.0.0.2', startTime: Date.now(),
      });

      fakeDataStream.emit('data', Buffer.alloc(100_000, 1));
      pumpOnce();

      expect(channel.isUpstreamPaused).toBeFalsy();
      expect((fakeDataStream as any).pause).not.toHaveBeenCalled();
    });

    it('resumes upstream immediately if second subscriber joins while paused', () => {
      const fakeDataStream = new EventEmitter();
      (fakeDataStream as any).pause = vi.fn();
      (fakeDataStream as any).resume = vi.fn();
      (fakeDataStream as any).destroy = vi.fn();

      const channel = streamHub.registerChannel(
        'source-bp',
        '104',
        'Join while paused Test',
        'live',
        'http://upstream.tv',
        { data: fakeDataStream }
      );

      const res1: any = new EventEmitter();
      res1.setHeader = vi.fn();
      res1.writableLength = 5 * 1024 * 1024;
      res1.write = vi.fn().mockReturnValue(false);

      streamHub.addSubscriber(channel.channelKey, {
        id: 'sub-bp-4a', res: res1, username: 'u1', playlistName: 'p', ip: '10.0.0.1', startTime: Date.now(),
      });

      fakeDataStream.emit('data', Buffer.alloc(100_000, 1));
      pumpOnce();
      expect(channel.isUpstreamPaused).toBe(true);

      // Second subscriber joins
      const res2: any = new EventEmitter();
      res2.setHeader = vi.fn();
      res2.writableLength = 0;
      res2.write = vi.fn().mockReturnValue(true);

      streamHub.addSubscriber(channel.channelKey, {
        id: 'sub-bp-4b', res: res2, username: 'u2', playlistName: 'p', ip: '10.0.0.2', startTime: Date.now(),
      });

      expect(channel.isUpstreamPaused).toBe(false);
      expect((fakeDataStream as any).resume).toHaveBeenCalled();
    });

    it('resumes upstream immediately if DVR recording is attached while paused', () => {
      const fakeDataStream = new EventEmitter();
      (fakeDataStream as any).pause = vi.fn();
      (fakeDataStream as any).resume = vi.fn();
      (fakeDataStream as any).destroy = vi.fn();

      const channel = streamHub.registerChannel(
        'source-bp',
        '105',
        'DVR while paused Test',
        'live',
        'http://upstream.tv',
        { data: fakeDataStream }
      );

      const res1: any = new EventEmitter();
      res1.setHeader = vi.fn();
      res1.writableLength = 5 * 1024 * 1024;
      res1.write = vi.fn().mockReturnValue(false);

      streamHub.addSubscriber(channel.channelKey, {
        id: 'sub-bp-5', res: res1, username: 'u1', playlistName: 'p', ip: '10.0.0.1', startTime: Date.now(),
      });

      fakeDataStream.emit('data', Buffer.alloc(100_000, 1));
      pumpOnce();
      expect(channel.isUpstreamPaused).toBe(true);

      // Attach DVR recording
      streamHub.attachDvr(channel.sourceId, channel.streamId, 'rec-1234');

      expect(channel.isUpstreamPaused).toBe(false);
      expect((fakeDataStream as any).resume).toHaveBeenCalled();
    });
  });
});



describe('computeBufferHealth', () => {
  const MBPS_6_8 = 850_000; // bytes per second
  const RESERVE_S = 18;

  it('reports the fill level relative to the reserve, not the memory cap', () => {
    const health = computeBufferHealth({
      bufferedBytes: MBPS_6_8 * RESERVE_S,
      rateBps: MBPS_6_8,
      reserveSeconds: RESERVE_S,
      starved: false,
    });
    expect(health.status).toBe('healthy');
    expect(health.fillPercent).toBe(100);
    expect(health.bufferedSeconds).toBe(18);
    expect(health.reserveSeconds).toBe(18);
    expect(health.starved).toBe(false);
  });

  it('flags a buffer that has drained below a third of the reserve', () => {
    const health = computeBufferHealth({
      bufferedBytes: MBPS_6_8 * 4,
      rateBps: MBPS_6_8,
      reserveSeconds: RESERVE_S,
      starved: false,
    });
    expect(health.fillPercent).toBe(22);
    expect(health.status).toBe('low');
  });

  it('reports a dry spell as starved with its duration', () => {
    const health = computeBufferHealth({
      bufferedBytes: 0,
      rateBps: MBPS_6_8,
      reserveSeconds: RESERVE_S,
      starved: true,
      starvedMs: 2400,
    });
    expect(health.status).toBe('starved');
    expect(health.starved).toBe(true);
    expect(health.starvedMs).toBe(2400);
    expect(health.fillPercent).toBe(0);
  });

  it('never calls an unmeasured stream starved - that is just the connect phase', () => {
    const health = computeBufferHealth({
      bufferedBytes: 0,
      rateBps: 0,
      reserveSeconds: RESERVE_S,
      starved: true,
    });
    expect(health.status).toBe('warming');
    expect(health.bufferedSeconds).toBe(0);
  });

  it('carries the last hiccup through for the tooltip', () => {
    const health = computeBufferHealth({
      bufferedBytes: MBPS_6_8 * RESERVE_S,
      rateBps: MBPS_6_8,
      reserveSeconds: RESERVE_S,
      starved: false,
      lastStarveAt: 1_700_000_000_000,
      lastStarveMs: 3100,
    });
    expect(health.status).toBe('healthy');
    expect(health.lastStarveAt).toBe(1_700_000_000_000);
    expect(health.lastStarveMs).toBe(3100);
  });

  it('caps the reported fill sensibly when the buffer overshoots the reserve', () => {
    const health = computeBufferHealth({
      bufferedBytes: MBPS_6_8 * RESERVE_S * 1.5,
      rateBps: MBPS_6_8,
      reserveSeconds: RESERVE_S,
      starved: false,
    });
    // The number stays honest (150 %) - the UI clamps the bar width, not the data.
    expect(health.fillPercent).toBe(150);
    expect(health.status).toBe('healthy');
  });
});

describe('nextPaceTrim', () => {
  it('leaves the pace alone while the buffer is healthy', () => {
    expect(nextPaceTrim(1, 0.9)).toBe(1);
    expect(nextPaceTrim(1, 1.05)).toBe(1);
    expect(nextPaceTrim(1, 0.8)).toBe(1); // band edge - still no correction
  });

  it('slows down step by step when the buffer runs low', () => {
    let trim = 1;
    for (let i = 0; i < 10; i++) trim = nextPaceTrim(trim, 0.5);
    expect(trim).toBeCloseTo(0.951, 3);
    expect(trim).toBeGreaterThan(LIVE_BUFFER_PACE_TRIM_MIN);
  });

  it('never slows the player below 95 % of the stream rate', () => {
    let trim = 1;
    for (let i = 0; i < 500; i++) trim = nextPaceTrim(trim, 0.1);
    expect(trim).toBe(LIVE_BUFFER_PACE_TRIM_MIN);
  });

  it('speeds up when the buffer piles up, bounded at 105 %', () => {
    let trim = 1;
    for (let i = 0; i < 500; i++) trim = nextPaceTrim(trim, 1.5);
    expect(trim).toBe(LIVE_BUFFER_PACE_TRIM_MAX);
  });

  it('recovers towards neutral once the level is back in the band', () => {
    // A trim that was pulled down stays put while the level is healthy - the band is
    // wide enough that it does not oscillate around the target.
    expect(nextPaceTrim(0.95, 0.9)).toBe(0.95);
  });

  it('ignores a nonsensical fill ratio', () => {
    expect(nextPaceTrim(1, Number.NaN)).toBe(1);
  });
});
