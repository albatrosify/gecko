import express from 'express';
import { log } from '../logger.ts';
import { proxyStats, registerStreamController, unregisterStreamController } from '../proxy-stats.ts';
import { StreamChannelSummary } from './stream-guard.ts';
import { recordTraffic } from '../traffic.ts';
import { createIpPinnedAgents, extractHostname, type IpPinnedAgents } from '../dns-resolver.ts';

/** How many consecutive reconnect failures to tolerate before waiting for the client. */
const RECONNECT_MAX_ATTEMPTS = 4;
/** Backoff between those attempts. */
const RECONNECT_RETRY_BACKOFF_MS = [2_000, 4_000, 8_000, 15_000];

// ── Live jitter buffer ────────────────────────────────────────────────────────
// Measured against real upstreams: several providers deliver a few MB in a ~200 ms
// burst and then nothing for ~5 s, so forwarding every chunk the instant it arrives
// turns each of those gaps into a stall on the client — the video freezes while the
// player burns through its own buffer, then playback jumps when data resumes.
// Holding a few seconds of content back and releasing it as the buffer refills
// covers those gaps from memory instead of from the player.
const LIVE_BUFFER_PUMP_MS = 50;
/** Largest slice the pacer releases at once; bounds how bursty output can look. */
const LIVE_SLICE_BYTES = 64_000;
/**
 * Sliding window of data time used to estimate the stream bitrate. Long enough to
 * smooth one provider burst cycle, short enough to track genuine rate changes.
 */
const LIVE_BUFFER_RATE_WINDOW_S = 60;
/** Minimum observed data span before the estimate is trusted. */
const LIVE_BUFFER_RATE_WARMUP_S = 3;
/**
 * Largest inter-data gap still counted as content time. Above this the provider was
 * not delivering content, and counting it would depress the pace below real time.
 * Real upstreams (like Tivione) regularly pause for 9.8-10.5 s between bursts.
 */
const LIVE_BUFFER_RATE_MAX_GAP_S = 12;
/**
 * Bounds for the slow drift correction of the pacing rate. The burst-window estimate
 * has a few percent of variance, and open-loop that makes the buffer random-walk; a
 * bounded trim pulls the level back without ever under-feeding the player by more.
 */
export const LIVE_BUFFER_PACE_TRIM_MIN = 0.95;
export const LIVE_BUFFER_PACE_TRIM_MAX = 1.05;
const LIVE_BUFFER_PACE_TRIM_STEP = 0.005;
/** How often the level is sampled for the drift correction. */
const LIVE_BUFFER_TRIM_INTERVAL_MS = 10_000;
/** Fill ratio (relative to the reserve) below which we slow down / above which we speed up. */
const LIVE_BUFFER_TRIM_LOW_FILL = 0.8;
const LIVE_BUFFER_TRIM_HIGH_FILL = 1.1;
// ── Subscriber backpressure limits ────────────────────────────────────────────
/** Grace period after a subscriber connects before buffer pressure counts against it. */
const STARTUP_GRACE_MS = 15_000;
/**
 * Per-subscriber buffer level above which the subscriber is treated as stalled.
 * Sized by the `STREAM_BUFFER_MB` env var (megabytes, default 16).
 */
const BUFFER_WARN_BYTES = (parseInt(process.env.STREAM_BUFFER_MB || '16', 10) || 16) * 1024 * 1024;
/** How long a subscriber may sit above the warn threshold before eviction. */
const MAX_STALL_MS = 15_000;
/** Absolute per-subscriber buffer ceiling; above this the subscriber is evicted immediately. */
const HARD_BUFFER_CAP_BYTES = BUFFER_WARN_BYTES * 2;
/**
 * Content kept queued at all times — the only latency the jitter buffer adds, and
 * what covers a provider outage. Output runs at the stream's own rate, so the reserve
 * stays constant instead of growing.
 *
 * `GECKO_LIVE_BUFFER_SECONDS` sets it; 0 disables pacing (plain pass-through). Providers
 * that go silent for longer than this will still interrupt playback, because a buffer
 * cannot cover content that was never delivered.
 */
const LIVE_BUFFER_DEFAULT_RESERVE_S = 18;
/**
 * Cap on accumulated allowance. Only meant to stop a long stall being repaid as one
 * huge burst — keep it far below the provider's gap length, or tokens bank through
 * every ordinary gap and get dumped as a sawtooth when the next gulp lands.
 */
const LIVE_BUFFER_BURST_SECONDS = 0.6;
/** Initial token burst granted on startup so playback starts instantly (<300ms) without draining the buffer. */
const LIVE_BUFFER_INITIAL_BURST_BYTES = 1_200_000;
/** Nominal bitrate estimate (800 KB/s = 6.4 Mbps HD) used during the first 3s warmup before measuredRate is ready. */
const LIVE_BUFFER_FALLBACK_RATE_BPS = 800_000;
/** Hard upper bound on nominal stream bitrate (2.5 MB/s = 20 Mbps). Accommodates FHD 50fps sports spikes and 4K streams. */
const LIVE_BUFFER_MAX_STREAM_RATE_BPS = 2_500_000;
/**
 * Shortest dry-buffer spell worth logging. The reserve drains to empty at the end of
 * every normal provider cycle by design, so only genuine interruptions are reported.
 */
const LIVE_BUFFER_STARVE_LOG_MS = 1_500;
/** Hard ceiling on jitter-buffer memory per channel. */
const LIVE_BUFFER_MAX_BYTES = 64_000_000;
/** If the upstream goes quiet for longer than this, release the buffer anyway. Scales with reserve. */
function liveBufferDrainAfterMs(): number {
  return (liveBufferReserveSeconds() * 2 + 15) * 1000;
}

/** Configured reserve depth in seconds; 0 means pacing is off. */
function liveBufferReserveSeconds(): number {
  const configured = Number(process.env.GECKO_LIVE_BUFFER_SECONDS ?? LIVE_BUFFER_DEFAULT_RESERVE_S);
  if (!Number.isFinite(configured) || configured < 0) return LIVE_BUFFER_DEFAULT_RESERVE_S;
  return configured;
}

function isLivePacingEnabled(): boolean {
  return liveBufferReserveSeconds() > 0;
}

/** Destroys both agents of a pinned pair, ignoring any close errors. */
function destroyIpPinnedAgents(agents?: IpPinnedAgents): void {
  if (!agents) return;
  try { agents.http.destroy(); } catch {}
  try { agents.https.destroy(); } catch {}
}

/** An upstream chunk plus the moment it arrived, which is what paces delivery. */
interface BufferedChunk {
  at: number;
  data: Buffer;
}

interface DownstreamSubscriber {
  id: string;
  playlistId?: string;
  req?: express.Request;
  res: express.Response;
  username: string;
  playlistName: string;
  ip: string;
  startTime: number;
  stalledSince?: number;
}

export interface UpstreamConfig {
  url: string;
  headers?: Record<string, string>;
  candidateIps?: string[];
  currentIpIndex?: number;
}
interface ActiveStreamChannel {
  channelKey: string;
  sourceId: string;
  streamId: string;
  streamName: string;
  /** Channel logo / poster for the dashboard card, when the provider has one. */
  streamIcon?: string;
  type: 'live' | 'movie' | 'series';
  hostUrl: string;
  upstreamResponse: any;
  upstreamAgents?: IpPinnedAgents;
  subscribers: Map<string, DownstreamSubscriber>;
  bytesRead: number;
  startTime: number;
  lastChunkAt?: number;
  upstreamConfig?: UpstreamConfig;
  dvrRecordingId?: string;
  headersSent?: Record<string, any>;
  /** Upstream chunks held back so bursty providers do not starve the client. */
  buffer: BufferedChunk[];
  bufferedBytes: number;
  /**
   * Bytes received per second of *data time*, used to estimate the stream's rate.
   * Anchored on the last chunk rather than the wall clock so a provider stall cannot
   * depress the estimate — a depressed rate would starve the player even while the
   * buffer still holds playable content.
   */
  rateBuckets: Map<number, number>;
  /** Slow, bounded correction applied to the pacing rate (see nextPaceTrim). */
  paceTrim?: number;
  lastTrimAt?: number;
  /** Leaky-bucket allowance that paces downstream delivery. */
  pacingTokens: number;
  lastPumpAt: number;
  /** Timestamp when the current upstream connection was established (or reconnected). */
  lastConnectAt?: number;
  /** True while the initial TCP connect-burst is still active; chunks build the buffer but don't inflate rateBuckets. */
  inInitialBurst?: boolean;
  /** Cumulative bytes received during the initial connect-burst window. */
  burstBytes?: number;
  /** Interval that releases buffered chunks to subscribers. */
  pumpTimer?: NodeJS.Timeout;
  /** Set while the buffer is empty with subscribers attached — i.e. a real stall. */
  starvedSince?: number;
  /** When the last completed starvation ended, and how long it lasted (dashboard gauge). */
  lastStarveAt?: number;
  lastStarveMs?: number;
  /** True once the current upstream silence has been reported, so it logs once. */
  gapWarned?: boolean;
}

type ChunkCallback = (channelKey: string, chunk: Buffer) => void;

export type BufferStatus = 'healthy' | 'low' | 'starved' | 'warming';

/**
 * How the jitter buffer looks right now, for the dashboard gauge.
 *
 * `fillPercent` is relative to the configured reserve, not to the memory cap: 100 %
 * means "exactly the amount of content the pump aims to hold", which is the only
 * figure that means the same thing on a 3 Mbps and a 12 Mbps channel.
 */
export interface ChannelBufferHealth {
  status: BufferStatus;
  fillPercent: number;
  bufferedSeconds: number;
  reserveSeconds: number;
  /** Pacing rate the gauge is computed against (bytes/s). */
  rateBps: number;
  starved: boolean;
  starvedMs?: number;
  lastStarveAt?: number;
  lastStarveMs?: number;
}

/** Below this share of the reserve the buffer is worth flagging. */
const LIVE_BUFFER_LOW_PERCENT = 30;

/** Slow, bounded correction of the pacing rate, driven purely by the buffer level. */
export function nextPaceTrim(current: number | undefined, fillRatio: number): number {
  const trim = typeof current === 'number' && Number.isFinite(current) ? current : 1;
  if (!Number.isFinite(fillRatio)) return trim;
  if (fillRatio < LIVE_BUFFER_TRIM_LOW_FILL) {
    return Math.max(LIVE_BUFFER_PACE_TRIM_MIN, trim * (1 - LIVE_BUFFER_PACE_TRIM_STEP));
  }
  if (fillRatio > LIVE_BUFFER_TRIM_HIGH_FILL) {
    return Math.min(LIVE_BUFFER_PACE_TRIM_MAX, trim * (1 + LIVE_BUFFER_PACE_TRIM_STEP));
  }
  return trim;
}

/**
 * Pure derivation of the gauge from the channel's counters, kept out of the hub so
 * the thresholds stay testable without a live upstream connection.
 */
export function computeBufferHealth(input: {
  bufferedBytes: number;
  rateBps: number;
  reserveSeconds: number;
  starved: boolean;
  starvedMs?: number;
  lastStarveAt?: number;
  lastStarveMs?: number;
}): ChannelBufferHealth {
  // Until the rate is measured we cannot translate bytes into seconds, and an empty
  // buffer during connect is expected - so that is "warming", not "starved".
  const warming = input.rateBps <= 0 || input.reserveSeconds <= 0;
  const bufferedSeconds = input.rateBps > 0 ? input.bufferedBytes / input.rateBps : 0;
  const reserveBytes = input.rateBps * input.reserveSeconds;
  const fillPercent = reserveBytes > 0
    ? Math.round((input.bufferedBytes / reserveBytes) * 100)
    : 0;

  let status: BufferStatus;
  if (warming) status = 'warming';
  else if (input.starved) status = 'starved';
  else if (fillPercent < LIVE_BUFFER_LOW_PERCENT) status = 'low';
  else status = 'healthy';

  return {
    status,
    fillPercent,
    bufferedSeconds: Math.round(bufferedSeconds * 10) / 10,
    reserveSeconds: input.reserveSeconds,
    rateBps: Math.round(input.rateBps),
    starved: input.starved,
    ...(input.starvedMs !== undefined ? { starvedMs: input.starvedMs } : {}),
    ...(input.lastStarveAt !== undefined ? { lastStarveAt: input.lastStarveAt } : {}),
    ...(input.lastStarveMs !== undefined ? { lastStarveMs: input.lastStarveMs } : {}),
  };
}

class StreamHub {
  private channels = new Map<string, ActiveStreamChannel>(); // channelKey -> ActiveStreamChannel
  private onChunkCallback?: ChunkCallback;

  setOnChunk(callback: ChunkCallback): void {
    this.onChunkCallback = callback;
  }

  static makeKey(sourceId: string, streamId: string): string {
    return `${sourceId}:${streamId}`;
  }

  hasChannel(sourceId: string, streamId: string): boolean {
    return this.channels.has(StreamHub.makeKey(sourceId, streamId));
  }

  getChannel(sourceId: string, streamId: string): ActiveStreamChannel | undefined {
    return this.channels.get(StreamHub.makeKey(sourceId, streamId));
  }

  getChannelByKey(channelKey: string): ActiveStreamChannel | undefined {
    return this.channels.get(channelKey);
  }

  /**
   * Jitter-buffer health for the dashboard, or null when there is nothing honest to
   * report: pacing disabled, unknown channel, or no subscribers (the pump drops the
   * buffer by design when nobody is watching, so a level would be meaningless).
   */
  getBufferHealth(channelKey: string): ChannelBufferHealth | null {
    if (!isLivePacingEnabled()) return null;
    const channel = this.channels.get(channelKey);
    if (!channel || channel.subscribers.size === 0) return null;

    const starvedSince = channel.starvedSince;
    return computeBufferHealth({
      bufferedBytes: channel.bufferedBytes,
      rateBps: this.measureUpstreamRate(channel),
      reserveSeconds: liveBufferReserveSeconds(),
      starved: starvedSince !== undefined,
      ...(starvedSince !== undefined ? { starvedMs: Date.now() - starvedSince } : {}),
      ...(channel.lastStarveAt !== undefined ? { lastStarveAt: channel.lastStarveAt } : {}),
      ...(channel.lastStarveMs !== undefined ? { lastStarveMs: channel.lastStarveMs } : {}),
    });
  }

  getActiveChannelsForSource(sourceId: string): StreamChannelSummary[] {
    const list: StreamChannelSummary[] = [];
    for (const channel of this.channels.values()) {
      if (channel.sourceId === sourceId) {
        list.push({
          channelKey: channel.channelKey,
          sourceId: channel.sourceId,
          streamId: channel.streamId,
          streamName: channel.streamName,
          subscriberCount: channel.subscribers.size,
          dvrRecordingId: channel.dvrRecordingId,
        });
      }
    }
    return list;
  }

  private isReconnecting = new Set<string>();

  /** Consecutive failed reconnect attempts per channel, used for backoff. */
  private reconnectRetries = new Map<string, number>();

  /**
   * Registers a new active upstream channel ingestion pipeline.
   */
  registerChannel(
    sourceId: string,
    streamId: string,
    streamName: string,
    type: 'live' | 'movie' | 'series',
    hostUrl: string,
    upstreamResponse: any,
    headersSent?: Record<string, any>,
    upstreamConfig?: UpstreamConfig,
    streamIcon?: string
  ): ActiveStreamChannel {
    const channelKey = StreamHub.makeKey(sourceId, streamId);

    // If channel already exists, destroy the old one first
    if (this.channels.has(channelKey)) {
      this.closeChannel(channelKey);
    }

    const channel: ActiveStreamChannel = {
      channelKey,
      sourceId,
      streamId,
      streamName,
      streamIcon,
      type,
      hostUrl,
      upstreamResponse,
      subscribers: new Map(),
      bytesRead: 0,
      startTime: Date.now(),
      lastChunkAt: Date.now(),
      lastConnectAt: Date.now(),
      inInitialBurst: true,
      burstBytes: 0,
      upstreamConfig,
      headersSent,
      buffer: [],
      bufferedBytes: 0,
      rateBuckets: new Map(),
      pacingTokens: isLivePacingEnabled() ? LIVE_BUFFER_INITIAL_BURST_BYTES : 0,
      paceTrim: 1,
      lastPumpAt: Date.now(),
    };

    this.channels.set(channelKey, channel);

    // ── Diagnostic & Self-healing gap detection ──────────────────────────────
    // Reset every time a chunk arrives.
    //
    // Thresholds are deliberately generous. Some providers deliver IPTV in
    // bursts — a few MB in ~200 ms, then ~5 s of dead air — and gecko sits
    // behind a VPN where the path itself is smooth (verified: 580 Mbps
    // sustained bulk download, 9-12 ms latency, no socket backlog). Reconnecting
    // inside such a burst window discards data the client could have played out
    // of its own buffer, which reads as a freeze, and the fresh connection
    // resumes from a different point in the origin's buffer, which reads as a
    // time jump. Real clients hold one connection and ride out short gaps, so
    // do the same: only reconnect once the gap is long enough that a player
    // buffer cannot cover it.
    const UPSTREAM_GAP_WARN_MS = 13_000;
    const UPSTREAM_GAP_RECONNECT_MS = 16_000;

    // Release buffered chunks on a fixed cadence so a bursty upstream is smoothed
    // into a continuous downstream stream.
    channel.pumpTimer = setInterval(() => this.pumpChannelBuffer(channel), LIVE_BUFFER_PUMP_MS);
    channel.pumpTimer.unref?.();
    let upstreamGapTimer = setInterval(() => {
      const silentMs = Date.now() - (channel.lastChunkAt || channel.startTime);
      if (
        silentMs >= UPSTREAM_GAP_RECONNECT_MS &&
        (channel.subscribers.size > 0 || channel.dvrRecordingId) &&
        channel.upstreamConfig
      ) {
        log(`[StreamHub] Upstream silent for ${silentMs} ms on ${channelKey} — triggering self-healing reconnect!`);
        channel.lastChunkAt = Date.now(); // bump to avoid re-triggering while in-flight
        this.reconnectChannel(channelKey, `silence gap (${silentMs} ms)`).catch(err => {
          log(`[StreamHub] Reconnect error for ${channelKey}: ${err.message}`);
        });
      } else if (silentMs >= UPSTREAM_GAP_WARN_MS) {
        // Report each silence once, on entry. Logging every second makes a single
        // 15 s outage look like eight separate incidents when the logs are counted.
        if (!channel.gapWarned) {
          log(`[StreamHub] ⚠️ Upstream silent for ${silentMs} ms on ${channelKey} (${channel.subscribers.size} subscribers waiting)`);
          channel.gapWarned = true;
        }
      } else {
        channel.gapWarned = false;
      }
    }, 1_000);

    // ── Diagnostic: periodic throughput report ────────────────────────────────
    let lastReportBytes = 0;
    const REPORT_INTERVAL_MS = 10_000;
    let throughputTimer = setInterval(() => {
      const delta = channel.bytesRead - lastReportBytes;
      lastReportBytes = channel.bytesRead;
      const kbps = Math.round((delta * 8) / (REPORT_INTERVAL_MS / 1000) / 1000);
      const bufKb = Math.round(channel.bufferedBytes / 1024);
      log(`[StreamHub][DIAG] ${channelKey} — ${kbps} kbps upstream | buf ${bufKb} KB | ${channel.subscribers.size} subscriber(s) | total ${Math.round(channel.bytesRead / 1024)} KB`);
    }, REPORT_INTERVAL_MS);

    (channel as any)._diagTimers = [upstreamGapTimer, throughputTimer];

    this.bindUpstreamResponse(channel);

    log(`[StreamHub] Registered new active channel: ${channelKey} (${streamName})`);
    return channel;
  }

  private bindUpstreamResponse(channel: ActiveStreamChannel): void {
    const upstreamResponse = channel.upstreamResponse;
    if (!upstreamResponse?.data) return;

    upstreamResponse.data.on('data', (chunk: Buffer) => {
      this.handleUpstreamChunk(channel, chunk);
    });

    const handleUpstreamEnd = (err?: any) => {
      const errMsg = err ? `: ${err.message}` : '';
      log(`[StreamHub] Upstream ended for ${channel.channelKey}${errMsg}`);
      if ((channel.subscribers.size > 0 || channel.dvrRecordingId) && channel.upstreamConfig) {
        this.reconnectChannel(channel.channelKey, `upstream closed${errMsg}`).then(ok => {
          if (!ok && channel.subscribers.size === 0) {
            this.closeChannel(channel.channelKey);
          }
        }).catch(() => {
          if (channel.subscribers.size === 0) this.closeChannel(channel.channelKey);
        });
      } else {
        this.closeChannel(channel.channelKey);
      }
    };

    upstreamResponse.data.on('end', handleUpstreamEnd);
    upstreamResponse.data.on('error', handleUpstreamEnd);
  }

  private handleUpstreamChunk(channel: ActiveStreamChannel, chunk: Buffer): void {
    const now = Date.now();
    const gapSinceLastChunk = channel.lastChunkAt ? now - channel.lastChunkAt : 0;
    channel.lastChunkAt = now;
    channel.bytesRead += chunk.length;
    proxyStats.totalBytes += chunk.length;
    proxyStats.intervalBytes += chunk.length;

    // Hold the chunk back in the jitter buffer instead of pushing it to subscribers
    // immediately; pumpChannelBuffer releases it once enough content is queued to
    // ride out the provider's next dead-air gap.
    this.enqueueChunk(channel, chunk, gapSinceLastChunk);

    // If DVR handover is streaming in background, advance its bandwidth stats
    if (channel.dvrRecordingId) {
      const hoConn = proxyStats.connections.get(`dvr-${channel.dvrRecordingId}`);
      if (hoConn) {
        hoConn.bytesRead += chunk.length;
        hoConn.intervalBytes += chunk.length;
      }
    }

    // If DVR recording attached, write chunk to recording file
    if (channel.dvrRecordingId && this.onChunkCallback) {
      try {
        this.onChunkCallback(channel.channelKey, chunk);
      } catch (err: any) {
        log(`[StreamHub] DVR chunk error: ${err.message}`);
      }
    }
  }

  /**
   * Queue an upstream chunk for paced delivery and track the stream's average rate.
   *
   * The average rate is what makes smoothing possible: it is measured over the whole
   * session, so it stays steady across the provider's dead-air gaps and gives the
   * pump a real-time target to release against.
   */
  private enqueueChunk(channel: ActiveStreamChannel, chunk: Buffer, gapSinceLastChunk = 0): void {
    const now = Date.now();
    const second = Math.floor(now / 1000);

    // Initial connect-burst filter:
    // Providers dump 20-30 MB of historical buffer over TCP at line speed on connect.
    // Holding those chunks primes our jitter buffer reserve, but counting them toward
    // bitrate would inflate the pace to 25 Mbps and drain the buffer in 40s!
    if (channel.inInitialBurst) {
      channel.burstBytes = (channel.burstBytes ?? 0) + chunk.length;
      const connectAgeMs = now - (channel.lastConnectAt || channel.startTime);
      if (connectAgeMs > 12_000 || (connectAgeMs > 3_000 && gapSinceLastChunk > 1_500)) {
        channel.inInitialBurst = false;
        // Only clear rateBuckets if a true high-volume TCP catch-up burst (>8 MB) occurred.
        // If it was just normal live chunks (like in unit tests or low-latency upstreams),
        // keep rateBuckets intact so early rate measurement works.
        if (channel.burstBytes > 8_000_000) {
          channel.rateBuckets.clear();
          log(`[StreamHub] Initial connect burst ended for ${channel.channelKey} (${Math.round(connectAgeMs / 1000)}s, ${Math.round(channel.burstBytes / 1024)} KB) — buffer primed with ${Math.round(channel.bufferedBytes / 1024)} KB. Starting steady-state rate tracking.`);
        }
      }
    }

    channel.rateBuckets.set(second, (channel.rateBuckets.get(second) ?? 0) + chunk.length);
    for (const key of channel.rateBuckets.keys()) {
      if (second - key > LIVE_BUFFER_RATE_WINDOW_S) channel.rateBuckets.delete(key);
    }

    // Slice large reads: providers deliver multi-megabyte gulps straight from the
    // socket, and a token bucket cannot release what it can never single-handedly
    // afford. Small slices let the pump meter output smoothly.
    if (chunk.length > LIVE_SLICE_BYTES) {
      for (let offset = 0; offset < chunk.length; offset += LIVE_SLICE_BYTES) {
        const slice = chunk.subarray(offset, Math.min(offset + LIVE_SLICE_BYTES, chunk.length));
        channel.buffer.push({ at: now, data: slice });
        channel.bufferedBytes += slice.length;
      }
    } else {
      channel.buffer.push({ at: now, data: chunk });
      channel.bufferedBytes += chunk.length;
    }

    // Bound memory: drop the oldest content if the buffer runs away.
    while (channel.bufferedBytes > LIVE_BUFFER_MAX_BYTES && channel.buffer.length > 1) {
      const dropped = channel.buffer.shift();
      channel.bufferedBytes -= dropped ? dropped.data.length : 0;
    }
  }

  /**
   * Estimate the stream's bitrate from bytes received per second of data time.
   *
   * Deliberately *not* `totalBytes / wallClockElapsed`: a provider stall would grow
   * the denominator while bytes stand still, dropping the pace below real time and
   * starving the player even though playable content is still buffered. Anchoring the
   * window on the last chunk we actually received freezes the estimate across a stall
   * and lets it recover as soon as data flows again.
   */
  private measureUpstreamRate(channel: ActiveStreamChannel): number {
    if (channel.rateBuckets.size === 0) return 0;
    const seconds = [...channel.rateBuckets.keys()].sort((a, b) => a - b);
    let total = 0;
    for (const bytes of channel.rateBuckets.values()) total += bytes;

    // Sum the span between consecutive data seconds, capping each gap. A short gap is
    // the provider's normal burst cycle and must count as content time, otherwise the
    // estimate inflates several-fold. A long gap is an outage that delivered no
    // content — counting it would depress the pace below real time and starve the
    // player for a minute afterwards even though data is flowing again.
    let spanSeconds = 0;
    for (let i = 1; i < seconds.length; i++) {
      spanSeconds += Math.min(seconds[i] - seconds[i - 1], LIVE_BUFFER_RATE_MAX_GAP_S);
    }
    if (spanSeconds < LIVE_BUFFER_RATE_WARMUP_S) return 0;

    // Bytes from the oldest second were delivered *before* the measured span begins,
    // so counting them inflates the rate — with two provider bursts that reads double
    // the truth, and pacing above real time drains the reserve instead of filling it.
    const oldestBytes = channel.rateBuckets.get(seconds[0]) ?? 0;
    const rawRate = (total - oldestBytes) / spanSeconds;
    return Math.min(LIVE_BUFFER_MAX_STREAM_RATE_BPS, Math.max(0, rawRate));
  }

  /**
   * Release buffered content to every subscriber at the upstream's average rate
   * using a leaky bucket.
   *
   * Pacing by *arrival time* does not help: chunks inside one of the provider's
   * multi-megabyte gulps arrive microseconds apart, so releasing them by age
   * replays the gulp shape and the client still starves during the dead air that
   * follows. Allowing bytes out at a measured rate instead converts any input shape
   * into a continuous downstream stream, and the queued content covers the gaps.
   *
   * Until a rate can be measured (need a few seconds of data) content passes
   * straight through, so playback starts immediately.
   */
  private pumpChannelBuffer(channel: ActiveStreamChannel): void {
    if (channel.subscribers.size === 0) {
      // Nobody to feed: drop stale content instead of holding it in memory.
      channel.buffer.length = 0;
      channel.bufferedBytes = 0;
      return;
    }

    const now = Date.now();
    const elapsedMs = Math.max(0, now - channel.lastPumpAt);
    channel.lastPumpAt = now;

    const measuredRate = isLivePacingEnabled() ? this.measureUpstreamRate(channel) : 0;

    // A dry buffer with subscribers attached is the condition that actually reaches
    // the player as an interruption. Checked before the empty-buffer return below —
    // putting it after would make it unreachable, since that is exactly the state it
    // needs to observe. Reported on recovery so a report of "it buffered" can be
    // matched against something concrete in the logs.
    if (channel.buffer.length === 0) {
      channel.starvedSince ??= now;
      channel.pacingTokens = 0;
      return;
    }
    if (channel.starvedSince !== undefined) {
      const starvedMs = now - channel.starvedSince;
      channel.lastStarveAt = now;
      channel.lastStarveMs = starvedMs;
      if (starvedMs >= LIVE_BUFFER_STARVE_LOG_MS) {
        log(`[StreamHub] ⚠️ Downstream starved for ${starvedMs} ms on ${channel.channelKey} — ${channel.subscribers.size} subscriber(s) had no data to play (client re-buffers)`);
      }
      channel.starvedSince = undefined;
    }

    const upstreamQuietMs = now - (channel.lastChunkAt || now);
    const drainFully = upstreamQuietMs > liveBufferDrainAfterMs();

    // Pacing is the only thing that gates release; the reserve is maintained by
    // releasing a little slower until it is filled. Gating release on the reserve
    // itself would make output gulp-synced, because the buffer only grows when a
    // gulp arrives.

    const effectiveRate = measuredRate > 0
      ? measuredRate
      : (isLivePacingEnabled() ? LIVE_BUFFER_FALLBACK_RATE_BPS : 0);
    const pacing = effectiveRate > 0 && !drainFully;
    const reserveBytes = effectiveRate * liveBufferReserveSeconds();
    // Pace at the stream's own rate. Two deliberate exceptions:
    //  - above 1.2x reserve, draw 8 % faster to burn excess buffer back down;
    //  - a slow trim of at most 5 % steers the level back to the reserve (see the
    //    update below). The trim is bounded on purpose: throttling far below 1.0x
    //    depletes the player's own buffer and stalls playback.
    const releaseRate = (pacing && channel.bufferedBytes > reserveBytes * 1.2
      ? effectiveRate * 1.08
      : effectiveRate) * (channel.paceTrim ?? 1);

    // Allowance accumulates at the release rate and is capped so a long stall cannot
    // be repaid as one huge burst. Allow burning down the initial startup burst.
    if (releaseRate > 0) {
      const cap = Math.max(LIVE_SLICE_BYTES, releaseRate * LIVE_BUFFER_BURST_SECONDS);
      channel.pacingTokens = channel.pacingTokens > cap
        ? channel.pacingTokens
        : Math.min(cap, channel.pacingTokens + (releaseRate * elapsedMs) / 1000);
    }

    const deadSubscribers: string[] = [];
    while (channel.buffer.length > 0) {
      const head = channel.buffer[0];
      // Before a rate exists, or when the upstream is gone rather than merely
      // quiet, release without pacing so the client keeps getting data.
      if (pacing && channel.pacingTokens < head.data.length) break;
      if (pacing) channel.pacingTokens -= head.data.length;

      channel.buffer.shift();
      channel.bufferedBytes -= head.data.length;
      const data = head.data;

      for (const [subId, sub] of Array.from(channel.subscribers.entries())) {
        if (sub.res.writableEnded || sub.res.destroyed || (sub.req && sub.req.destroyed) || sub.res.writable === false) {
          deadSubscribers.push(subId);
          continue;
        }

        try {
          const ok = sub.res.write(data);
          const conn = proxyStats.connections.get(subId);
          if (conn) {
            conn.bytesRead += data.length;
            conn.intervalBytes += data.length;
          }
          recordTraffic(sub.playlistId, sub.playlistName, channel.type || 'live', data.length);

          if (sub.res.destroyed || sub.res.writableEnded) {
            deadSubscribers.push(subId);
            continue;
          }

          if (!ok) {
            const bufLen = sub.res.writableLength || 0;
            const now = Date.now();
            const inStartupGrace = (now - sub.startTime) < STARTUP_GRACE_MS;

            if (bufLen > HARD_BUFFER_CAP_BYTES) {
              log(`[StreamHub] Evicting runaway subscriber ${subId} — buffer ${Math.round(bufLen / 1024)} KB > ${HARD_BUFFER_CAP_BYTES / 1024} KB hard limit.`);
              try { sub.res.destroy(); } catch {}
              deadSubscribers.push(subId);
              continue;
            }

            if (bufLen > BUFFER_WARN_BYTES && !inStartupGrace) {
              if (!sub.stalledSince) {
                sub.stalledSince = now;
              } else if (now - sub.stalledSince > MAX_STALL_MS) {
                log(`[StreamHub] Evicting stalled subscriber ${subId} — buffer ${Math.round(bufLen / 1024)} KB sustained for >${MAX_STALL_MS / 1000}s.`);
                try { sub.res.destroy(); } catch {}
                deadSubscribers.push(subId);
                continue;
              }
            } else if (bufLen <= BUFFER_WARN_BYTES) {
              sub.stalledSince = undefined;
            }
          } else {
            sub.stalledSince = undefined;
          }
        } catch (err: any) {
          log(`[StreamHub] Error writing to subscriber ${subId}: ${err.message}`);
          try { sub.res.destroy(); } catch {}
          deadSubscribers.push(subId);
        }
      }
    }

    // The burst-window estimate carries a few percent of variance (measured +-7 % per
    // minute on Tivione), and open-loop that makes the buffer random-walk: one observed
    // run fell to 3 s of buffer, where any provider pause reaches the player as a
    // re-buffer. A slow, bounded trim pulls the level back towards the reserve without
    // ever under-feeding the player by more than 5 %.
    if (pacing && now - (channel.lastTrimAt ?? 0) >= LIVE_BUFFER_TRIM_INTERVAL_MS) {
      const fillRatio = channel.bufferedBytes / Math.max(1, reserveBytes);
      channel.paceTrim = nextPaceTrim(channel.paceTrim, fillRatio);
      channel.lastTrimAt = now;
    }

    for (const deadId of deadSubscribers) {
      this.removeSubscriber(channel.channelKey, deadId).catch(err => {
        log(`[StreamHub] Error removing dead subscriber ${deadId}: ${err.message}`);
      });
    }

  }

  /**
   * Attempts an in-place upstream reconnect without dropping downstream clients.
   * Subscribers keep their sockets open and their players draw from their local buffer
   * until fresh chunks start flowing from the newly established upstream socket.
   */
  async reconnectChannel(channelKey: string, reason: string): Promise<boolean> {
    const channel = this.channels.get(channelKey);
    if (!channel || !channel.upstreamConfig) return false;
    if (channel.subscribers.size === 0 && !channel.dvrRecordingId) {
      this.closeChannel(channelKey);
      return false;
    }
    if (this.isReconnecting.has(channelKey)) {
      return false;
    }

    this.isReconnecting.add(channelKey);
    log(`[StreamHub] 🔄 Reconnecting upstream for ${channelKey} (${reason}) | ${channel.subscribers.size} subscriber(s) waiting...`);

    let agents: IpPinnedAgents | undefined;
    try {
      if (channel.upstreamResponse?.data?.destroy) {
        try { channel.upstreamResponse.data.destroy(); } catch {}
      }
      destroyIpPinnedAgents(channel.upstreamAgents);
      channel.upstreamAgents = undefined;

      const candidateIps = channel.upstreamConfig.candidateIps;
      if (candidateIps && candidateIps.length > 0) {
        let targetIp: string;
        if (candidateIps.length > 1) {
          const currentIpIndex = ((channel.upstreamConfig.currentIpIndex ?? 0) + 1) % candidateIps.length;
          channel.upstreamConfig.currentIpIndex = currentIpIndex;
          targetIp = candidateIps[currentIpIndex];
          log(`[StreamHub] 🔄 In-place reconnecting ${channelKey} rotating to IP ${targetIp} (${currentIpIndex + 1}/${candidateIps.length})`);
        } else {
          targetIp = candidateIps[0];
        }
        agents = createIpPinnedAgents(targetIp, extractHostname(channel.upstreamConfig.url).hostname);
      }

      const axios = (await import('axios')).default;
      const response = await axios({
        method: 'get',
        url: channel.upstreamConfig.url,
        responseType: 'stream',
        timeout: 8000,
        headers: channel.upstreamConfig.headers || { 'User-Agent': 'Mozilla/5.0 IPTV-Proxy/1.0' },
        validateStatus: () => true,
        ...(agents ? { httpAgent: agents.http, httpsAgent: agents.https } : {}),
      });

      if (response.status >= 400) {
        log(`[StreamHub] ⚠️ Reconnect failed for ${channelKey}: Upstream returned HTTP ${response.status}`);
        if (response.data?.destroy) try { response.data.destroy(); } catch {}
        destroyIpPinnedAgents(agents);
        this.scheduleReconnectRetry(channelKey, `HTTP ${response.status}`);
        return false;
      }

      if ((response.request as any)?.setTimeout) (response.request as any).setTimeout(0);
      if ((response.data as any)?.socket?.setTimeout) (response.data as any).socket.setTimeout(0);
      (response.data as any)?.socket?.setKeepAlive?.(true, 10000);

      channel.upstreamResponse = response;
      channel.upstreamAgents = agents;
      channel.lastChunkAt = Date.now();
      channel.lastConnectAt = Date.now();
      channel.inInitialBurst = true;
      channel.burstBytes = 0;
      channel.rateBuckets.clear();
      this.bindUpstreamResponse(channel);
      log(`[StreamHub] ✅ In-place reconnect SUCCEEDED for ${channelKey}! Seamlessly resumed stream for ${channel.subscribers.size} subscriber(s).`);

      // If a DVR recording is attached to this channel, flag that a timestamp discontinuity occurred
      if (channel.dvrRecordingId) {
        try {
          const { dvrRecorder } = await import('../dvr/recorder.ts');
          dvrRecorder.markDiscontinuity(channel.dvrRecordingId, reason);
        } catch {}
      }

      return true;
    } catch (err: any) {
      destroyIpPinnedAgents(agents);
      log(`[StreamHub] ⚠️ Reconnect error for ${channelKey}: ${err.message}`);
      this.scheduleReconnectRetry(channelKey, err.message);
      return false;
    } finally {
      this.isReconnecting.delete(channelKey);
    }
  }

  /**
   * A reconnect attempt destroys the old upstream before opening the new one, so a
   * refused attempt (providers answer 407/500/503 while they are struggling) would
   * otherwise leave the channel with no upstream and no way back: the existing
   * subscriber sockets stay open but nothing is ever forwarded again, and the
   * client only recovers by giving up and reconnecting on its own.
   *
   * Retry while somebody is still watching, backing off between attempts, and give
   * up only when nobody is left.
   */
  private scheduleReconnectRetry(channelKey: string, reason: string): void {
    const channel = this.channels.get(channelKey);
    if (!channel || this.reconnectRetries.has(channelKey)) return;
    if (channel.subscribers.size === 0 && !channel.dvrRecordingId) {
      this.closeChannel(channelKey);
      return;
    }
    const attempt = (this.reconnectRetries.get(channelKey) ?? 0) + 1;
    if (attempt > RECONNECT_MAX_ATTEMPTS) {
      log(`[StreamHub] ❌ Giving up on ${channelKey} after ${RECONNECT_MAX_ATTEMPTS} failed reconnect attempts (${reason}). Waiting for a client to reconnect.`);
      this.reconnectRetries.delete(channelKey);
      return;
    }
    this.reconnectRetries.set(channelKey, attempt);
    const delayMs = RECONNECT_RETRY_BACKOFF_MS[attempt - 1];
    log(`[StreamHub] ⏳ Retry ${attempt}/${RECONNECT_MAX_ATTEMPTS} for ${channelKey} in ${delayMs} ms (${reason}) | ${channel.subscribers.size} subscriber(s) waiting`);
    const timer = setTimeout(() => {
      this.reconnectRetries.delete(channelKey);
      this.reconnectChannel(channelKey, `retry ${attempt} after ${reason}`).catch(err => {
        log(`[StreamHub] Reconnect error for ${channelKey}: ${err.message}`);
      });
    }, delayMs);
    timer.unref?.();
  }

  /**
   * Subscribes a downstream client to an active channel.
   */
  addSubscriber(
    channelKey: string,
    sub: DownstreamSubscriber
  ): boolean {
    const channel = this.channels.get(channelKey);
    if (!channel) return false;

    // Set forward headers on downstream response
    if (channel.headersSent) {
      for (const [header, val] of Object.entries(channel.headersSent)) {
        if (val) sub.res.setHeader(header, val);
      }
    }
    sub.res.setHeader('Content-Type', 'video/mp2t');
    sub.res.setHeader('Connection', 'keep-alive');
    sub.res.setHeader('Cache-Control', 'no-cache, no-store');
    sub.res.setHeader('X-Accel-Buffering', 'no');
    sub.res.socket?.setNoDelay?.(true);

    channel.subscribers.set(sub.id, sub);

    // Track connection in proxyStats
    const connectionInfo = {
      id: sub.id,
      channelKey,
      sourceId: channel.sourceId,
      playlistId: sub.playlistId,
      host: channel.hostUrl,
      username: sub.username,
      streamId: channel.streamId,
      streamName: channel.streamName,
      streamIcon: channel.streamIcon,
      playlistName: sub.playlistName,
      type: channel.type,
      ip: sub.ip,
      startTime: sub.startTime,
      bytesRead: 0,
      intervalBytes: 0,
      currentBps: 0,
      proxied: true,
      subscriberCount: channel.subscribers.size,
      recordingId: channel.dvrRecordingId,
    };
    proxyStats.connections.set(sub.id, connectionInfo as any);
    proxyStats.activeStreams++;

    // Update subscriberCount on all sibling subscribers in proxyStats
    this.syncSubscriberCount(channel);

    // If there was a DVR Handover connection card in proxyStats, remove it because human viewer has joined!
    if (channel.dvrRecordingId) {
      const handoverConnId = `dvr-${channel.dvrRecordingId}`;
      if (proxyStats.connections.has(handoverConnId)) {
        proxyStats.connections.delete(handoverConnId);
        proxyStats.activeStreams = Math.max(0, proxyStats.activeStreams - 1);
      }
    }

    // Handle subscriber disconnect (guaranteed idempotent across req & res)
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      try {
        sub.res.destroy();
      } catch (err: any) {
        log(`[StreamHub] Error destroying subscriber response for ${sub.id}: ${err.message}`);
      }
      this.removeSubscriber(channelKey, sub.id).catch(err => {
        log(`[StreamHub] Error removing subscriber on disconnect ${sub.id}: ${err.message}`);
      });
    };
    registerStreamController(
      sub.id,
      () => cleanup(),
      () => !sub.res.destroyed && !sub.res.writableEnded && !(sub.req && sub.req.destroyed)
    );
    if (sub.req) {
      sub.req.on('close', cleanup);
      sub.req.socket?.on('close', cleanup);
      sub.req.socket?.on('error', cleanup);
    }
    sub.res.on('finish', cleanup);
    sub.res.on('close', cleanup);
    sub.res.on('error', cleanup);

    // Reset backpressure stall tracking whenever socket drains
    sub.res.on('drain', () => {
      sub.stalledSince = undefined;
    });

    log(`[StreamHub] Subscriber ${sub.id} joined ${channelKey} (${channel.subscribers.size} active viewers on this stream)`);
    return true;
  }

  /**
   * Removes a downstream client from an active channel.
   */
  async removeSubscriber(channelKey: string, subId: string): Promise<void> {
    const channel = this.channels.get(channelKey);
    if (!channel) return;

    const sub = channel.subscribers.get(subId);
    if (sub) {
      if (!sub.res.destroyed) {
        try {
          sub.res.destroy();
        } catch {}
      }
      channel.subscribers.delete(subId);

      if (proxyStats.connections.has(subId)) {
        proxyStats.connections.delete(subId);
        proxyStats.activeStreams = Math.max(0, proxyStats.activeStreams - 1);
      }
      unregisterStreamController(subId);

      this.syncSubscriberCount(channel);
      log(`[StreamHub] Subscriber ${subId} left ${channelKey} (${channel.subscribers.size} remaining viewers)`);
    }

    // Check if any viewers remain
    if (channel.subscribers.size === 0) {
      if (channel.dvrRecordingId) {
        // DVR Handover: Keep upstream alive for recording!
        log(`[StreamHub] All viewers left ${channelKey}, but DVR is recording (${channel.dvrRecordingId}). Stream kept alive.`);
        const { dvrRecorder } = await import('../dvr/recorder.ts');
        dvrRecorder.handleDownstreamClose(channel.dvrRecordingId);

        // Add a Handover entry to proxyStats so the dashboard clearly shows that the stream is recording in background!
        const handoverConnId = `dvr-${channel.dvrRecordingId}`;
        if (!proxyStats.connections.has(handoverConnId)) {
          proxyStats.connections.set(handoverConnId, {
            id: handoverConnId,
            channelKey,
            sourceId: channel.sourceId,
            username: 'Gecko DVR',
            streamId: channel.streamId,
            streamName: channel.streamName,
            playlistName: '📁 Gecko DVR (Handover)',
            type: channel.type,
            ip: '127.0.0.1',
            startTime: channel.startTime,
            bytesRead: channel.bytesRead,
            intervalBytes: 0,
            currentBps: 0,
            proxied: true,
            subscriberCount: 0,
            recordingId: channel.dvrRecordingId,
            isHandover: true,
          });
          proxyStats.activeStreams++;
          // Killing the handover card stops the recording and tears the channel down.
          registerStreamController(handoverConnId, () => {
            void import('../dvr/recorder.ts').then(({ dvrRecorder }) => dvrRecorder.stopRecording(channel.dvrRecordingId!));
            this.closeChannel(channelKey);
          });
        }
      } else {
        // No viewers and no DVR -> Tear down upstream connection
        log(`[StreamHub] No viewers left for ${channelKey}. Tearing down upstream connection.`);
        this.closeChannel(channelKey);
      }
    }
  }

  /**
   * Attaches a DVR recording to an active stream channel.
   */
  attachDvr(sourceId: string, streamId: string, recordingId: string): boolean {
    const channelKey = StreamHub.makeKey(sourceId, streamId);
    const channel = this.channels.get(channelKey);
    if (!channel) return false;

    channel.dvrRecordingId = recordingId;
    this.syncRecordingId(channel, recordingId);
    log(`[StreamHub] Attached DVR recording ${recordingId} to active channel ${channelKey}`);
    return true;
  }

  /**
   * Detaches a DVR recording from an active stream channel.
   */
  detachDvr(sourceId: string, streamId: string): void {
    const channelKey = StreamHub.makeKey(sourceId, streamId);
    const channel = this.channels.get(channelKey);
    if (!channel) return;

    const oldDvrId = channel.dvrRecordingId;
    if (oldDvrId) {
      const handoverConnId = `dvr-${oldDvrId}`;
      if (proxyStats.connections.has(handoverConnId)) {
        proxyStats.connections.delete(handoverConnId);
        proxyStats.activeStreams = Math.max(0, proxyStats.activeStreams - 1);
      }
      unregisterStreamController(handoverConnId);
    }
    channel.dvrRecordingId = undefined;
    this.syncRecordingId(channel, undefined);
    log(`[StreamHub] Detached DVR from channel ${channelKey}`);

    // If no human viewers are left either, close upstream connection
    if (channel.subscribers.size === 0) {
      log(`[StreamHub] No viewers remaining after DVR stop. Closing channel ${channelKey}.`);
      this.closeChannel(channelKey);
    }
  }

  /**
   * Completely closes and tears down an active channel.
   */
  closeChannel(channelKey: string): void {
    const channel = this.channels.get(channelKey);
    if (!channel) return;
    this.isReconnecting.delete(channelKey);

    // If a DVR recording was attached when channel closes, stop and finalize recording session
    if (channel.dvrRecordingId) {
      const recId = channel.dvrRecordingId;
      channel.dvrRecordingId = undefined;
      const handoverConnId = `dvr-${recId}`;
      if (proxyStats.connections.has(handoverConnId)) {
        proxyStats.connections.delete(handoverConnId);
        proxyStats.activeStreams = Math.max(0, proxyStats.activeStreams - 1);
      }
      unregisterStreamController(handoverConnId);
      import('../dvr/recorder.ts').then(({ dvrRecorder }) => {
        dvrRecorder.stopRecording(recId).catch(err => {
          log(`[StreamHub] Failed to finalize DVR recording ${recId} on channel close: ${err.message}`);
        });
      }).catch((err) => {
        log(`[StreamHub] Failed to load DVR recorder while finalizing ${recId}: ${err?.message ?? err}`);
      });
    }

    // Close all remaining subscriber connections
    for (const sub of channel.subscribers.values()) {
      if (!sub.res.writableEnded && !sub.res.destroyed) {
        try {
          sub.res.end();
        } catch {}
      }
      if (proxyStats.connections.has(sub.id)) {
        proxyStats.connections.delete(sub.id);
        proxyStats.activeStreams = Math.max(0, proxyStats.activeStreams - 1);
      }
      unregisterStreamController(sub.id);
    }
    channel.subscribers.clear();
    this.reconnectRetries.delete(channelKey);
    clearInterval(channel.pumpTimer);
    channel.buffer.length = 0;
    channel.bufferedBytes = 0;

    // Clear diagnostic timers
    if ((channel as any)._diagTimers) {
      for (const t of (channel as any)._diagTimers) clearInterval(t);
    }

    // Destroy upstream response
    if (channel.upstreamResponse?.data?.destroy) {
      channel.upstreamResponse.data.destroy();
    }
    destroyIpPinnedAgents(channel.upstreamAgents);
    channel.upstreamAgents = undefined;

    this.channels.delete(channelKey);
    log(`[StreamHub] Channel ${channelKey} closed.`);
  }

  private syncSubscriberCount(channel: ActiveStreamChannel) {
    const count = channel.subscribers.size;
    for (const sub of channel.subscribers.values()) {
      const conn = proxyStats.connections.get(sub.id);
      if (conn) {
        (conn as any).subscriberCount = count;
      }
    }
  }

  private syncRecordingId(channel: ActiveStreamChannel, recordingId?: string) {
    for (const sub of channel.subscribers.values()) {
      const conn = proxyStats.connections.get(sub.id);
      if (conn) {
        if (recordingId) {
          (conn as any).recordingId = recordingId;
        } else {
          delete (conn as any).recordingId;
        }
      }
    }
  }

  reset(): void {
    for (const key of Array.from(this.channels.keys())) {
      this.closeChannel(key);
    }
  }
}

export const streamHub = new StreamHub();
