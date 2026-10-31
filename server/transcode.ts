import { spawn, type ChildProcessByStdio } from 'child_process';
import type { Readable } from 'stream';

/** ffmpeg is spawned with stdin ignored and stdout/stderr piped. */
type TranscodeChild = ChildProcessByStdio<null, Readable, Readable>;
import type { Request, Response } from 'express';
import { log } from './logger.ts';
import { recordTraffic } from './traffic.ts';
import { proxyStats, registerStreamController, unregisterStreamController } from './proxy-stats.ts';

/**
 * Live audio transcoding.
 *
 * Browsers can demux MPEG-TS fine (mpegts.js), but their MediaSource
 * implementation rejects audio codecs it cannot decode — most importantly
 * Dolby Digital (AC-3), E-AC-3 and DTS, which IPTV providers use constantly for
 * their HD channels. Without this module the web player has to drop the audio
 * track entirely (video-only fallback).
 *
 * Here we keep the video bitstream untouched (`-c:v copy`, no quality loss, a
 * few percent of one core) and only re-encode audio to AAC/48 kHz/stereo, which
 * every browser plays. The result is still MPEG-TS, so the existing mpegts.js
 * pipeline works unchanged and there is no new transport to maintain.
 *
 * The transcoder always pulls from the *loopback* proxy URL, not from the
 * upstream directly: host failover, multi-IP pinning, VPN routing, the
 * concurrency guard and the stream multiplexer therefore all behave exactly as
 * they do for a normal viewer.
 */

const DEFAULT_MAX_CONCURRENT_TRANSCODES = 4;

/** Tail of ffmpeg's stderr kept for the error message if it dies early. */
const STDERR_TAIL_BYTES = 4000;

export interface TranscodeSession {
  id: string;
  playlistId: string;
  streamId: string;
  streamName: string;
  clientIp: string;
  startedAt: number;
  /** Last spawned ffmpeg; null between retry attempts. */
  child: TranscodeChild | null;
  bytesOut: number;
}

export interface AudioTranscodeRequest {
  /** Internal loopback URL of the (already proxied) live stream. */
  upstreamUrl: string;
  playlistId: string;
  playlistName: string;
  username: string;
  streamId: string;
  streamName: string;
  clientIp: string;
}

const activeSessions = new Map<string, TranscodeSession>();

/**
 * Parse the concurrency cap from an env value. Invalid/empty input falls back to
 * the default; `0` or a negative number disables audio transcoding entirely.
 */
export function parseTranscodeLimit(raw: string | undefined, fallback = DEFAULT_MAX_CONCURRENT_TRANSCODES): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, parsed);
}

export function getTranscodeLimit(): number {
  return parseTranscodeLimit(process.env.GECKO_MAX_AUDIO_TRANSCODES);
}

export function getActiveTranscodeCount(): number {
  return activeSessions.size;
}

export function getTranscodeStats(): { active: number; limit: number; bytesOut: number } {
  let bytesOut = 0;
  for (const session of activeSessions.values()) bytesOut += session.bytesOut;
  return { active: activeSessions.size, limit: getTranscodeLimit(), bytesOut };
}

/**
 * ffmpeg arguments for "copy the video, make the audio playable".
 *
 * `-map …?` makes both maps optional so an audio-less (or video-less) channel
 * does not abort the whole process. Probing is deliberately capped: the default
 * 5 s / 5 MB budget is fine for files but adds seconds of zap time on live TS.
 */
export function buildAudioTranscodeArgs(upstreamUrl: string): string[] {
  return [
    '-nostdin',
    '-hide_banner',
    '-loglevel', 'error',
    // Abort instead of hanging forever when the loopback stops delivering.
    '-rw_timeout', '30000000',
    '-probesize', '1000000',
    '-analyzeduration', '1000000',
    // Not a security boundary: it only tells the proxy that this loopback
    // viewer is our own transcoder, so it is neither counted as a viewer nor
    // billed twice in the traffic stats.
    '-user_agent', 'Gecko-Transcode/1.0',
    '-headers', 'x-gecko-transcode: 1\r\n',
    '-i', upstreamUrl,
    '-map', '0:v:0?',
    '-map', '0:a:0?',
    // Video stays untouched — no quality loss and barely any CPU.
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '160k',
    '-ac', '2',
    '-ar', '48000',
    // Keep the muxing latency low; the stream is live, not a file.
    '-muxdelay', '0',
    '-muxpreload', '0',
    '-flush_packets', '1',
    '-f', 'mpegts',
    'pipe:1',
  ];
}

/**
 * ffmpeg reports HTTP failures as `Server returned 404 Not Found` — but only for
 * statuses it knows. Everything else is collapsed:
 *
 *   409 → "Server returned 4XX Client Error, but not one of 40{0,1,3,4}"
 *   5xx → "Server returned 5XX Server Error reply"
 *
 * The input here is always our own loopback proxy, which only produces
 * 400/401/403/404 (recognised by ffmpeg and printed verbatim), 409 and 5xx. So
 * the collapsed messages can be mapped back unambiguously.
 */
export function parseUpstreamStatus(stderr: string): number | null {
  const exact = /Server returned (\d{3})\b/.exec(stderr);
  if (exact) {
    const status = Number(exact[1]);
    return Number.isFinite(status) ? status : null;
  }
  if (/4XX Client Error, but not one of 40\{0,1,3,4\}/.test(stderr)) return 409;
  if (/5XX Server Error reply/.test(stderr)) return 502;
  const alternate = /HTTP error (\d{3})/i.exec(stderr);
  return alternate ? Number(alternate[1]) : null;
}

/** Strips the loopback URL (which carries playlist credentials) from ffmpeg output. */
export function sanitizeDetail(stderr: string): string {
  return stderr
    .replace(/https?:\/\/\S+/g, '<stream-url>')
    .trim()
    .split('\n')
    .slice(-2)
    .join(' ')
    .slice(0, 400);
}

function killChild(child: TranscodeChild, signal: NodeJS.Signals): void {
  try {
    if (!child.killed) child.kill(signal);
  } catch {}
}

/**
 * Starts an audio-only transcode and streams it to `res`.
 *
 * Headers are only sent with the first output chunk: if ffmpeg dies while
 * probing (bad upstream, unsupported container) the client still receives a
 * real HTTP error instead of an empty 200 it would have to interpret.
 */
export function handleAudioTranscode(req: Request, res: Response, opts: AudioTranscodeRequest): void {
  const limit = getTranscodeLimit();
  if (limit === 0) {
    res.status(503).json({
      error: 'transcode_disabled',
      message: 'Audio transcoding is disabled on this server (GECKO_MAX_AUDIO_TRANSCODES=0).',
    });
    return;
  }
  if (activeSessions.size >= limit) {
    res.status(503).json({
      error: 'transcode_capacity',
      message: `Audio transcoding is at capacity (${activeSessions.size}/${limit} streams). Close another stream or raise GECKO_MAX_AUDIO_TRANSCODES.`,
    });
    return;
  }

  const id = crypto.randomUUID();
  const ffmpegPath = process.env.GECKO_FFMPEG_PATH || 'ffmpeg';

  /**
   * The provider allows one connection per account in most setups, and answers
   * the next attempt with 409/513 for a few seconds. Switching a live player from
   * "direct" to "transcoded" necessarily opens a fresh upstream connection, so a
   * short backoff is part of the design here rather than an edge case.
   */
  const MAX_ATTEMPTS = 3;
  const RETRY_DELAYS_MS = [1500, 3000];

  const session: TranscodeSession = {
    id,
    playlistId: opts.playlistId,
    streamId: String(opts.streamId),
    streamName: opts.streamName,
    clientIp: opts.clientIp,
    startedAt: Date.now(),
    child: null,
    bytesOut: 0,
  };
  activeSessions.set(id, session);

  const connId = `transcode-${id}`;
  proxyStats.connections.set(connId, {
    id: connId,
    playlistId: opts.playlistId,
    username: opts.username,
    streamId: String(opts.streamId),
    streamName: `${opts.streamName} [AAC]`,
    playlistName: opts.playlistName,
    type: 'live',
    ip: opts.clientIp,
    startTime: session.startedAt,
    bytesRead: 0,
    intervalBytes: 0,
    currentBps: 0,
    proxied: true,
    transcoded: true,
  } as any);
  proxyStats.activeStreams++;

  let headersSent = false;
  let finished = false;
  let attempt = 0;
  let currentChild: TranscodeChild | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  let lastStderr = '';

  const releaseResources = (): void => {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    activeSessions.delete(id);
    if (proxyStats.connections.has(connId)) {
      proxyStats.connections.delete(connId);
      proxyStats.activeStreams = Math.max(0, proxyStats.activeStreams - 1);
    }
    unregisterStreamController(connId);
  };

  const cleanup = (reason: string): void => {
    if (finished) return;
    finished = true;

    const durationS = ((Date.now() - session.startedAt) / 1000).toFixed(1);
    releaseResources();

    if (currentChild) {
      killChild(currentChild, 'SIGTERM');
      const forceKill = setTimeout(() => { if (currentChild) killChild(currentChild, 'SIGKILL'); }, 2000);
      forceKill.unref?.();
    }

    if (!res.writableEnded && !res.destroyed) {
      try { res.end(); } catch {}
    }

    log(`[Transcode] ${opts.streamId} (${opts.streamName}) stopped after ${durationS}s — ${reason}`);
  };

  /** Gives up before anything was streamed and answers with a real HTTP error. */
  const failBeforeStart = (status: number, error: string, message: string): void => {
    if (finished) return;
    finished = true;
    releaseResources();
    if (!res.headersSent) {
      if (status === 409 || status === 503) res.setHeader('Retry-After', '5');
      res.status(status).json({ error, message, detail: sanitizeDetail(lastStderr) || undefined });
    }
    log(`[Transcode] ${opts.streamId} gave up after ${attempt} attempt(s) — ${status} ${error}`);
  };

  const startAttempt = (): void => {
    if (finished || res.destroyed || res.writableEnded || req.destroyed) {
      cleanup('client went away before the stream started');
      return;
    }
    attempt++;

    let child: TranscodeChild;
    try {
      child = spawn(ffmpegPath, buildAudioTranscodeArgs(opts.upstreamUrl), { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err: any) {
      log(`[Transcode] Failed to spawn ${ffmpegPath}: ${err?.message || err}`);
      failBeforeStart(500, 'transcode_spawn_failed', 'ffmpeg could not be started on the server.');
      return;
    }

    currentChild = child;
    session.child = child;
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      if (finished) return;
      if (res.destroyed || res.writableEnded) {
        cleanup('client went away');
        return;
      }

      if (!headersSent) {
        headersSent = true;
        res.status(200);
        res.setHeader('Content-Type', 'video/mp2t');
        res.setHeader('Cache-Control', 'no-cache, no-store');
        res.setHeader('Connection', 'keep-alive');
        // Never let a reverse proxy buffer the live stream.
        res.setHeader('X-Accel-Buffering', 'no');
        res.setHeader('X-Gecko-Transcode', 'audio');
        res.socket?.setNoDelay?.(true);
        log(`[Transcode] ${opts.streamId} (${opts.streamName}) started for ${opts.clientIp} - ffmpeg pid ${child.pid}, attempt ${attempt}`);
      }

      session.bytesOut += chunk.length;
      const conn = proxyStats.connections.get(connId);
      if (conn) {
        conn.bytesRead += chunk.length;
        conn.intervalBytes += chunk.length;
      }
      recordTraffic(opts.playlistId, opts.playlistName, 'live', chunk.length);

      // Respect downstream backpressure: if the player stalls we must stop
      // reading ffmpeg's stdout, otherwise the whole TS accumulates in memory.
      if (!res.write(chunk)) child.stdout.pause();
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(-STDERR_TAIL_BYTES);
      lastStderr = stderr;
    });

    child.stdout.on('error', (err: any) => {
      log(`[Transcode] stdout error for ${opts.streamId}: ${err?.message || err}`);
      cleanup('stdout error');
    });

    child.on('error', (err: any) => {
      // Spawn failures (ENOENT for a missing ffmpeg) arrive here, not as a throw.
      log(`[Transcode] ${ffmpegPath} error: ${err?.message || err}`);
      if (!headersSent) {
        failBeforeStart(500, 'transcode_spawn_failed', 'ffmpeg could not be started on the server.');
        return;
      }
      cleanup('ffmpeg error');
    });

    child.on('exit', (code, signal) => {
      if (finished) return;

      if (headersSent) {
        const abnormal = code !== 0;
        if (abnormal && stderr.trim()) {
          log(`[Transcode] ${opts.streamId} ffmpeg exited code=${code} signal=${signal}: ${sanitizeDetail(stderr)}`);
        }
        cleanup(`ffmpeg exited (code=${code} signal=${signal})`);
        return;
      }

      // Died during probing — either retry or surface the reason.
      const upstreamStatus = parseUpstreamStatus(stderr);
      log(`[Transcode] ${opts.streamId} attempt ${attempt}/${MAX_ATTEMPTS} failed before first output (code=${code} signal=${signal}): ${sanitizeDetail(stderr)}`);

      const retryable = upstreamStatus !== null && [409, 429, 500, 502, 503, 504].includes(upstreamStatus);
      if (retryable && attempt < MAX_ATTEMPTS) {
        const delayMs = RETRY_DELAYS_MS[attempt - 1] ?? 3000;
        log(`[Transcode] ${opts.streamId} upstream ${upstreamStatus} - retrying in ${delayMs} ms (the provider may still be releasing the previous slot)`);
        retryTimer = setTimeout(() => {
          retryTimer = null;
          startAttempt();
        }, delayMs);
        retryTimer.unref?.();
        return;
      }

      if (upstreamStatus === 403 || upstreamStatus === 404) {
        failBeforeStart(upstreamStatus, 'transcode_failed', 'The provider rejected the stream (expired credentials or the channel is offline).');
        return;
      }
      if (upstreamStatus === 409) {
        failBeforeStart(409, 'upstream_slot_busy', 'The provider account is currently busy with another connection. Retry in a few seconds.');
        return;
      }
      failBeforeStart(502, 'transcode_failed', 'The stream could not be re-encoded. The upstream may have failed or gone offline.');
    });
  };

  // Makes the dashboard's kill switch (and "kill all") tear down this ffmpeg too.
  registerStreamController(
    connId,
    () => cleanup('killed from dashboard'),
    () => !res.destroyed && !res.writableEnded
  );

  res.on('drain', () => {
    if (!finished) currentChild?.stdout.resume();
  });

  // Client-side teardown — the single most common reason a transcode stops.
  req.on('close', () => cleanup('client closed'));
  res.on('close', () => cleanup('response closed'));
  res.on('finish', () => cleanup('response finished'));

  startAttempt();
}

/** Kill every running transcode (process shutdown). */
export function stopAllTranscoders(): void {
  for (const session of Array.from(activeSessions.values())) {
    if (session.child) killChild(session.child, 'SIGKILL');
    activeSessions.delete(session.id);
    const connId = `transcode-${session.id}`;
    if (proxyStats.connections.has(connId)) {
      proxyStats.connections.delete(connId);
      proxyStats.activeStreams = Math.max(0, proxyStats.activeStreams - 1);
    }
    unregisterStreamController(connId);
  }
}
