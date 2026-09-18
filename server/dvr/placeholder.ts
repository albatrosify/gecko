import fs from 'fs';
import path from 'path';
import express from 'express';
import { log } from '../logger.ts';
import { DvrSourceLock } from './connection-arbiter.ts';

export const PLACEHOLDER_PATHS = [
  path.join(process.cwd(), 'data', 'placeholder.ts'),
  path.join(process.cwd(), 'data', 'placeholder.mp4'),
];

/**
 * Serves the placeholder stream when a source is locked by DVR.
 * For MPEG-TS (live streams), streams the placeholder in an infinite loop until the client disconnects.
 * For MP4, streams the file with Content-Length.
 * If no placeholder file exists, returns HTTP 503.
 */
export function servePlaceholderStream(
  res: express.Response,
  lock: DvrSourceLock,
  requestedStreamId: string
): void {
  const channelInfo = lock.streamName ? `"${lock.streamName}"` : `Stream ${lock.streamId}`;
  log(`[DVR Placeholder] Routing request for stream ${requestedStreamId} to placeholder because source ${lock.sourceId} is recording ${channelInfo}`);

  const tsPath = path.join(process.cwd(), 'data', 'placeholder.ts');
  const mp4Path = path.join(process.cwd(), 'data', 'placeholder.mp4');

  if (fs.existsSync(tsPath)) {
    // Continuous live MPEG-TS loop
    res.writeHead(200, {
      'Content-Type': 'video/mp2t',
      'Connection': 'keep-alive',
      'Cache-Control': 'no-cache, no-store',
    });

    let activeStream: fs.ReadStream | null = null;
    let isClosed = false;

    const streamNextLoop = () => {
      if (isClosed || res.writableEnded || res.destroyed) return;
      activeStream = fs.createReadStream(tsPath);
      activeStream.pipe(res, { end: false });
      activeStream.on('end', () => {
        if (!isClosed && !res.writableEnded && !res.destroyed) {
          streamNextLoop();
        }
      });
      activeStream.on('error', (err) => {
        log(`[DVR Placeholder] Stream error: ${err.message}`);
      });
    };

    const cleanup = () => {
      isClosed = true;
      if (activeStream) {
        activeStream.destroy();
        activeStream = null;
      }
    };

    res.on('close', cleanup);
    res.on('finish', cleanup);

    streamNextLoop();
    return;
  }

  if (fs.existsSync(mp4Path)) {
    try {
      const stat = fs.statSync(mp4Path);
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': stat.size,
        'Cache-Control': 'no-cache, no-store',
      });
      fs.createReadStream(mp4Path).pipe(res);
      return;
    } catch (err: any) {
      log(`[DVR Placeholder] Error reading mp4 placeholder: ${err.message}`);
    }
  }

  // Fallback if user hasn't provided a video file yet
  res.status(503).send(
    `Gecko DVR: Aufnahme aktiv auf ${channelInfo}. Der Upstream erlaubt nur 1 Verbindung. Bitte im Gecko Dashboard pruefen.`
  );
}
