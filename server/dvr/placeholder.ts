import fs from 'fs';
import path from 'path';
import express from 'express';
import { spawn } from 'child_process';
import { log } from '../logger.ts';
import { DvrSourceLock } from './connection-arbiter.ts';
import { generateId } from '../db.ts';
import { proxyStats } from '../proxy-stats.ts';

export const PLACEHOLDER_PATHS = [
  path.join(process.cwd(), 'data', 'placeholder.ts'),
  path.join(process.cwd(), 'data', 'placeholder.mp4'),
];

/**
 * Serves the placeholder stream when a source is locked by DVR or another stream.
 * Uses real-time rate pacing and infinite looping via FFmpeg so players like TiviMate / ExoPlayer
 * receive a steady, continuous live stream with monotonic timestamps without buffer overflow or freeze.
 * Also registers the connection in proxyStats so it appears in the Gecko Dashboard ("Now Playing").
 */
export function servePlaceholderStream(
  req: express.Request,
  res: express.Response,
  lock: DvrSourceLock,
  requestedStreamId: string,
  streamName?: string,
  playlistName?: string,
  username?: string
): void {
  const channelInfo = lock.streamName ? `"${lock.streamName}"` : `Stream ${lock.streamId}`;
  const displayName = streamName || `Stream ${requestedStreamId}`;
  log(`[DVR Placeholder] Routing request for stream ${requestedStreamId} (${displayName}) to placeholder because source ${lock.sourceId} is active with ${channelInfo}`);

  const mp4Path = path.join(process.cwd(), 'data', 'placeholder.mp4');
  const tsPath = path.join(process.cwd(), 'data', 'placeholder.ts');
  const videoPath = fs.existsSync(mp4Path) ? mp4Path : (fs.existsSync(tsPath) ? tsPath : null);

  if (videoPath) {
    const connId = generateId();
    res.writeHead(200, {
      'Content-Type': 'video/mp2t',
      'Connection': 'keep-alive',
      'Cache-Control': 'no-cache, no-store',
    });

    const connectionInfo = {
      id: connId,
      sourceId: lock.sourceId,
      username: username || 'client',
      streamId: requestedStreamId,
      streamName: `${displayName} (Gesperrt: ${channelInfo})`,
      playlistName: playlistName || username || 'Client',
      type: 'live',
      ip: req.ip || req.headers['x-forwarded-for']?.toString() || 'unknown',
      startTime: Date.now(),
      bytesRead: 0,
      intervalBytes: 0,
      currentBps: 0,
      proxied: false,
      isPlaceholder: true,
    };
    proxyStats.connections.set(connId, connectionInfo as any);
    proxyStats.activeStreams++;

    let ffmpegProc: any = null;
    let cleanedUp = false;

    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      if (ffmpegProc) {
        try { ffmpegProc.kill('SIGKILL'); } catch {}
        ffmpegProc = null;
      }
      try {
        if (!res.writableEnded && !res.destroyed) res.end();
      } catch {}
      if (proxyStats.connections.has(connId)) {
        proxyStats.connections.delete(connId);
        proxyStats.activeStreams = Math.max(0, proxyStats.activeStreams - 1);
      }
      log(`[DVR Placeholder] Client disconnected from placeholder for ${requestedStreamId}`);
    };

    req.on('close', cleanup);
    req.on('end', cleanup);
    req.socket?.on('close', cleanup);
    req.socket?.on('error', cleanup);
    res.on('finish', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);

    try {
      // Spawn ffmpeg with real-time rate pacing (-re) and infinite looping (-stream_loop -1)
      ffmpegProc = spawn('ffmpeg', [
        '-re',
        '-stream_loop', '-1',
        '-i', videoPath,
        '-c', 'copy',
        '-f', 'mpegts',
        'pipe:1',
      ], { stdio: ['ignore', 'pipe', 'ignore'] });

      ffmpegProc.stdout.on('data', (chunk: Buffer) => {
        connectionInfo.bytesRead += chunk.length;
        connectionInfo.intervalBytes += chunk.length;
        proxyStats.totalBytes += chunk.length;
        proxyStats.intervalBytes += chunk.length;

        if (!res.writableEnded && !res.destroyed) {
          try {
            res.write(chunk);
          } catch {
            cleanup();
          }
        }
      });

      ffmpegProc.on('close', cleanup);
      ffmpegProc.on('error', (err: any) => {
        log(`[DVR Placeholder] FFmpeg spawn error: ${err.message}`);
        cleanup();
      });
      return;
    } catch (err: any) {
      log(`[DVR Placeholder] Failed to spawn FFmpeg for placeholder: ${err.message}`);
      cleanup();
    }
  }

  // Fallback if no placeholder file exists
  res.status(503).send(
    `Gecko DVR: Aufnahme aktiv auf ${channelInfo}. Der Upstream erlaubt nur 1 Verbindung. Bitte im Gecko Dashboard pruefen.`
  );
}
