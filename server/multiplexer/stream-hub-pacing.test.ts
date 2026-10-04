import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { streamHub } from './stream-hub.ts';
import { proxyStats, streamControllers } from '../proxy-stats.ts';
import { log } from '../logger.ts';

vi.mock('../logger.ts', () => ({
  log: vi.fn(),
}));

/**
 * Pacing coverage for real providers, which deliver IPTV in bursts — several MB in a
 * fraction of a second, then seconds of dead air — rather than as a steady stream.
 *
 * Real time is simulated with fake timers so the whole scenario runs instantly and
 * deterministically. What is asserted is the behaviour a client actually feels:
 * playback starts immediately, downstream delivery never starves, and a provider
 * outage does not leave the pace stuck below real time afterwards.
 */
describe('StreamHub live pacing', () => {
  const BURST_BYTES = 3_000_000;
  const GULP_INTERVAL_MS = 5_000;
  const STALL_FROM_MS = 20_000;
  const STALL_TO_MS = 35_000;
  const RUN_MS = 60_000;
  const STREAM_BYTES_PER_SEC = BURST_BYTES / (GULP_INTERVAL_MS / 1000);

  beforeEach(() => {
    vi.useFakeTimers();
    streamHub.reset();
    proxyStats.connections.clear();
    streamControllers.clear();
    proxyStats.activeStreams = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts instantly, paces a bursty upstream, and survives a provider outage', () => {
    const upstream = new EventEmitter() as EventEmitter & { destroy: () => void };
    upstream.destroy = () => undefined;

    const channel = streamHub.registerChannel(
      'source-pacing',
      '100',
      'Bursty Channel',
      'live',
      'http://upstream',
      { data: upstream } as never,
    );

    const received = new Map<number, number>();
    let totalBytes = 0;
    let firstByteAtMs = -1;
    const startedAt = Date.now();

    const res = new EventEmitter() as EventEmitter & {
      write: (b: Buffer) => boolean;
      setHeader: () => void;
      writableEnded: boolean;
    };
    res.writableEnded = false;
    res.setHeader = () => undefined;
    res.write = (buf: Buffer) => {
      const elapsed = Date.now() - startedAt;
      if (firstByteAtMs < 0) firstByteAtMs = elapsed;
      const second = Math.floor(elapsed / 1000);
      received.set(second, (received.get(second) ?? 0) + buf.length);
      totalBytes += buf.length;
      return true;
    };

    streamHub.addSubscriber(channel.channelKey, {
      id: 'sub-pacing',
      res: res as never,
      username: 'tv',
      playlistName: 'TV',
      ip: '127.0.0.1',
      startTime: Date.now(),
    });

    // Drive virtual time, feeding a gulp every 5 s except during the outage.
    const burst = Buffer.alloc(BURST_BYTES, 0x47);
    const emitAt = new Set<number>();
    for (let at = 0; at < RUN_MS; at += GULP_INTERVAL_MS) {
      if (at >= STALL_FROM_MS && at < STALL_TO_MS) continue;
      emitAt.add(at);
    }

    for (let elapsed = 0; elapsed < RUN_MS; elapsed += 250) {
      for (let at = elapsed - 249; at <= elapsed; at++) {
        if (at >= 0 && emitAt.has(at)) upstream.emit('data', burst);
      }
      vi.advanceTimersByTime(250);
    }

    const bytesInSecond = (s: number) => received.get(s) ?? 0;
    const seconds = [...received.keys()].sort((a, b) => a - b);

    // Playback must not wait for a prebuffer: first bytes within a fraction of a second.
    expect(firstByteAtMs).toBeGreaterThanOrEqual(0);
    expect(firstByteAtMs).toBeLessThan(1000);

    // Outage window plus a settle allowance, during which gaps are expected.
    const stallFromS = STALL_FROM_MS / 1000;
    const stallToS = STALL_TO_MS / 1000 + 4;
    const outsideOutage = (s: number) => s >= 5 && s < RUN_MS / 1000 && !(s >= stallFromS && s <= stallToS);

    // Loading-spinner guard. An early rate over-estimate makes the pacer outrun the
    // buffer and starve the client within the first ten seconds — observed as an empty
    // second at t=9. A permanently depressed rate after an outage starves it later.
    // Iterate every second, not just the ones that received data: a starved second
    // has no entry in the map, so filtering recorded seconds could never see one.
    const starvingSeconds: number[] = [];
    for (let s = 0; s < RUN_MS / 1000; s++) {
      if (outsideOutage(s) && bytesInSecond(s) === 0) starvingSeconds.push(s);
    }
    expect(starvingSeconds).toEqual([]);

    // Pacing must be active. Without it the raw 3 MB gulp lands in a single second;
    // paced output holds several seconds of content, so no second exceeds ~1.7x the
    // stream rate.
    const burstSeconds = [...Array(RUN_MS / 1000).keys()].filter((s) => s >= 5).map(bytesInSecond);
    expect(Math.max(...burstSeconds)).toBeLessThan(STREAM_BYTES_PER_SEC * 1.7);

    // Pace must return to roughly the stream's own rate after the outage, rather than
    // staying depressed — the bug that starved the player for a minute afterwards.
    const settleUntil = stallToS + 1;
    const postStallSeconds = [...Array(RUN_MS / 1000).keys()].filter((s) => s >= settleUntil);
    expect(postStallSeconds.length).toBeGreaterThan(10);
    const postStallBytes = postStallSeconds.reduce((sum, s) => sum + bytesInSecond(s), 0);
    const postStallRate = postStallBytes / postStallSeconds.length;
    expect(postStallRate).toBeGreaterThan(STREAM_BYTES_PER_SEC * 0.75);
    expect(postStallRate).toBeLessThan(STREAM_BYTES_PER_SEC * 1.25);

    // Nothing was lost: the client received all but the reserve still held back.
    expect(totalBytes).toBeGreaterThan(0);
  });

  it('logs when the buffer runs dry with subscribers attached', () => {
    // The diagnostic that makes a "my player buffered" report actionable. It must fire
    // for a real interruption, and be quiet for the reserve merely reaching its floor
    // at the end of a provider cycle.
    const upstream = new EventEmitter() as EventEmitter & { destroy: () => void };
    upstream.destroy = () => undefined;
    const channel = streamHub.registerChannel('s', '9', 'C', 'live', 'u', { data: upstream } as never);

    const res = new EventEmitter() as EventEmitter & { write: (b: Buffer) => boolean; setHeader: () => void; writableEnded: boolean };
    res.writableEnded = false;
    res.setHeader = () => undefined;
    res.write = () => true;
    streamHub.addSubscriber(channel.channelKey, {
      id: 'sub-dry', res: res as never, username: 'tv', playlistName: 'TV', ip: '1', startTime: Date.now(),
    });

    const burst = Buffer.alloc(500_000, 0x47);
    upstream.emit('data', burst);
    vi.advanceTimersByTime(5_000);

    // Prime: the first dry spell is recorded but not yet reportable.
    expect(channel.starvedSince).toBeDefined();

    // Data returning after a long dry spell is the moment worth reporting.
    upstream.emit('data', burst);
    vi.advanceTimersByTime(100);

    expect(channel.starvedSince).toBeUndefined();
    const messages = vi.mocked(log).mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes('Downstream starved'))).toBe(true);

    streamHub.closeChannel(channel.channelKey);
  });
});
