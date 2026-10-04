import fs from 'fs';
import type { Request, Response } from 'express';

/** How long to wait before re-stating a file we already drained. */
const POLL_INTERVAL_MS = 250;
/** How often the growth check runs while following an in-progress recording. */
const GROWTH_CHECK_MS = 1000;

/** How long a follow-mode response may sit at EOF before we assume the recorder is gone. */
const STALL_TIMEOUT_MS = 30_000;

export interface RecordingPlaybackOptions {
  /** Absolute path of the recording file. */
  filePath: string;
  /** True while the recorder is still appending to the file. */
  isGrowing: boolean;
  /**
   * Re-check of {@link isGrowing}, called while following the file so the
   * response ends shortly after the recording stops instead of hanging forever.
   */
  isStillGrowing?: () => boolean;
  /** Called with the number of bytes handed to the response. */
  onBytes?: (bytes: number) => void;
}

/**
 * Resolve a `Range: bytes=start[-end]` header against a file of `fileSize` bytes.
 * Returns the clamped byte window, or null when the header is absent or unusable
 * (in which case the caller serves the whole file).
 */
function parseRange(range: string | undefined, fileSize: number): { start: number; end: number } | null {
  const match = range ? /^bytes=(\d+)-(\d*)$/.exec(range.trim()) : null;
  if (!match) return null;
  const start = parseInt(match[1], 10);
  const end = match[2] === '' ? fileSize - 1 : parseInt(match[2], 10);
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= fileSize) return null;
  return { start, end: Math.min(end, fileSize - 1) };
}

/** Pipe one byte window of a file into `res`, resolving when that window is drained. */
function pumpRange(
  filePath: string,
  start: number,
  end: number,
  res: Response,
  onBytes?: (bytes: number) => void,
): Promise<void> {
  // `Promise.withResolvers` is unavailable under this project's `lib` target.
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res2, rej) => {
    resolve = res2;
    reject = rej;
  });

  const file = fs.createReadStream(filePath, { start, end, highWaterMark: 64 * 1024 });
  let settled = false;
  const finish = (err?: Error) => {
    if (settled) return;
    settled = true;
    file.destroy();
    if (err) reject(err);
    else resolve();
  };
  file.on('data', (chunk: Buffer) => onBytes?.(chunk.length));
  file.on('error', finish);
  file.on('end', () => finish());
  file.on('close', () => finish());
  file.pipe(res, { end: false });
  return promise;
}

/**
 * Serve a recording file over HTTP.
 *
 * Finished recordings behave like a static file: seekable, with Content-Length /
 * Content-Range frozen at a single stat.
 *
 * In-progress recordings are served in *follow* mode: the response carries no
 * Content-Length and the reader keeps re-stating the file, shipping new bytes as
 * the recorder appends them, until the recording stops or the client goes away.
 * Freezing the size instead ends the response at whatever the file happened to
 * hold when playback started — that is what makes resuming an active recording
 * stall and re-buffer.
 */
export function serveRecordingFile(req: Request, res: Response, opts: RecordingPlaybackOptions): void {
  const { filePath, isGrowing, isStillGrowing, onBytes } = opts;

  const fileSize = fs.statSync(filePath).size;
  const rangeHeader = req.headers.range;
  const window = parseRange(rangeHeader, fileSize);
  // A client asking for a bounded window (bytes=A-B) gets exactly that window and
  // no tail; an open-ended one (bytes=A-) gets everything that follows.
  const isBoundedRange = !!rangeHeader && /\d+$/.test(rangeHeader.trim());

  if (!isGrowing) {
    if (window) {
      res.writeHead(206, {
        'Content-Range': `bytes ${window.start}-${window.end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': window.end - window.start + 1,
        'Content-Type': 'video/mp2t',
      });
      const file = fs.createReadStream(filePath, { start: window.start, end: window.end });
      file.on('data', (chunk: Buffer) => onBytes?.(chunk.length));
      file.on('error', () => res.end());
      file.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Accept-Ranges': 'bytes',
        'Content-Type': 'video/mp2t',
      });
      const file = fs.createReadStream(filePath);
      file.on('data', (chunk: Buffer) => onBytes?.(chunk.length));
      file.on('error', () => res.end());
      file.pipe(res);
    }
    return;
  }

  const headers: Record<string, string | number> = {
    'Accept-Ranges': 'bytes',
    'Content-Type': 'video/mp2t',
    'Cache-Control': 'no-store',
  };
  if (isBoundedRange && window) {
    res.writeHead(206, {
      ...headers,
      'Content-Range': `bytes ${window.start}-${window.end}/${fileSize}`,
      'Content-Length': window.end - window.start + 1,
    });
    res.flushHeaders();
    pumpRange(filePath, window.start, window.end, res, onBytes)
      .catch(() => undefined)
      .finally(() => res.end());
    return;
  }

  // Transfer until close: no Content-Length, `bytes start-*/*` so the client keeps
  // consuming while the file grows.
  res.writeHead(206, { ...headers, 'Content-Range': `bytes ${window ? window.start : 0}-*/*` });
  res.flushHeaders();

  let position = window ? window.start : 0;
  let stopped = false;
  const stopFollowing = () => {
    stopped = true;
  };
  res.on('close', stopFollowing);
  req.on('aborted', stopFollowing);

  (async () => {
    try {
      let stalledSince: number | null = null;
      while (!stopped) {
        const size = fs.statSync(filePath).size;
        if (position < size) {
          stalledSince = null;
          const windowEnd = size - 1;
          await pumpRange(filePath, position, windowEnd, res, onBytes);
          position = windowEnd + 1;
          continue;
        }
        if (isStillGrowing && !isStillGrowing()) break;
        // The recorder keeps its state in memory, so a restart leaves rows marked
        // `recording` whose files no longer grow. Do not hold the connection open
        // on those — end the response once the tail has been idle for a while.
        stalledSince ??= Date.now();
        if (Date.now() - stalledSince > STALL_TIMEOUT_MS) break;
        await new Promise<void>((resolveWait) => {
          const timer = setTimeout(resolveWait, POLL_INTERVAL_MS);
          timer.unref?.();
        });
      }
    } catch {
      // file removed or read error — fall through to end the response
    } finally {
      res.off('close', stopFollowing);
      req.off('aborted', stopFollowing);
      if (!res.writableEnded) res.end();
    }
  })();

  // The recorder may stop while we sit at EOF; re-check on a timer so the tail of a
  // finished recording is flushed and the response closes.
  const check = setInterval(() => {
    if (stopped || !isStillGrowing?.()) {
      clearInterval(check);
      stopped = true;
    }
  }, GROWTH_CHECK_MS);
  check.unref?.();
  res.on('close', () => clearInterval(check));
}