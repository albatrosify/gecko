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
});

