import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { getDb, generateId } from '../db.ts';
import { recordings } from '../schema.ts';
import { log } from '../logger.ts';
import { proxyStats } from '../proxy-stats.ts';
import { connectionArbiter } from './connection-arbiter.ts';
import { sendTelegramNotification } from '../telegram.ts';
import { formatBytes } from '../utils.ts';
import { eq, desc } from 'drizzle-orm';
import { Recording } from '../../src/types.ts';

export const RECORDINGS_DIR = process.env.DVR_STORAGE_PATH || path.join(process.cwd(), 'data', 'recordings');

// Ensure recordings storage directory exists
if (!fs.existsSync(RECORDINGS_DIR)) {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
}

export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}h ${m.toString().padStart(2, '0')}m ${s.toString().padStart(2, '0')}s`;
  }
  return `${m}m ${s.toString().padStart(2, '0')}s`;
}

/**
 * Deterministically computes a positive 32-bit integer for a recording ID.
 * Maps into the 900,000,000 - 999,999,999 range so it fits in signed 32-bit int
 * (max 2,147,483,647) and avoids collisions with typical upstream stream IDs.
 */
export function recordingIdToNumeric(recId: string): number {
  let hash = 5381;
  for (let i = 0; i < recId.length; i++) {
    hash = ((hash << 5) + hash) + recId.charCodeAt(i);
    hash = hash & 0x7fffffff;
  }
  return 900000000 + (hash % 100000000);
}

export interface ActiveRecordingSession {
  recordingId: string;
  connId: string;
  userId: string;
  playlistId?: string;
  sourceId: string;
  streamId: string;
  streamName: string;
  startTime: number;
  filePath: string;
  writeStream: fs.WriteStream;
  bytesWritten: number;
  isHandover: boolean;
  handoverAt?: number;
  hourlyTimer?: NodeJS.Timeout;
  /** Auto-stop timer for server-side recordings with a requested duration. */
  durationLimitTimer?: NodeJS.Timeout;
  /** Tears down the internal loopback request that feeds a server-side recording. */
  abortUpstream?: () => void;
  /** Set once the proxy attached this recording to a live channel. */
  attached?: boolean;
  /** Reason why attaching to a channel failed (source locked etc.). */
  attachError?: string;
  upstreamResponse?: any;
}

class DvrRecorder {
  private sessions = new Map<string, ActiveRecordingSession>(); // recordingId -> session
  private connToRecording = new Map<string, string>(); // connId -> recordingId
  private numericIdToRecId = new Map<number, string>();
  private recIdToNumericId = new Map<string, number>();

  /**
   * Starts recording from an existing live proxy connection (stream tee).
   */
  async startLiveRecordingFromConnection(connId: string, userId: string): Promise<Recording> {
    const conn = proxyStats.connections.get(connId);
    if (!conn) {
      throw new Error(`Connection ${connId} not found or no longer active.`);
    }

    if (this.connToRecording.has(connId)) {
      const existingId = this.connToRecording.get(connId)!;
      const existing = this.sessions.get(existingId);
      if (existing) {
        return this.getRecordingById(existingId)!;
      }
    }

    const recordingId = generateId();
    const sourceId = conn.sourceId;
    const streamId = String(conn.streamId);
    const streamName = conn.streamName || `Stream ${streamId}`;

    const channelKey = conn.channelKey || `${sourceId}:${streamId}`;

    // Acquire lock from arbiter
    const locked = connectionArbiter.acquireDvrLock(sourceId, streamId, recordingId, streamName);
    if (!locked) {
      throw new Error(`Die Quelle ist bereits durch eine andere Aufnahme gesperrt.`);
    }

    const filePath = path.join(RECORDINGS_DIR, `${recordingId}.ts`);
    const writeStream = fs.createWriteStream(filePath, { flags: 'a' });
    const now = new Date();
    const startTimeMs = now.getTime();
    const startTimeIso = now.toISOString();

    const db = getDb();
    db.insert(recordings).values({
      id: recordingId,
      userId,
      playlistId: conn.playlistName,
      sourceId,
      streamId,
      streamName,
      channelName: streamName,
      type: 'live',
      status: 'recording',
      startTime: startTimeIso,
      endTime: null,
      durationSeconds: 0,
      fileSizeBytes: 0,
      filePath,
      extra: {
        isHandover: false,
      },
    }).run();

    // Mark connection info so UI knows it's being recorded
    (conn as any).recordingId = recordingId;

    // Set up hourly reminder timer
    const hourlyTimer = this.startHourlyReminder(recordingId, streamName);

    const session: ActiveRecordingSession = {
      recordingId,
      connId,
      userId,
      playlistId: conn.playlistName,
      sourceId,
      streamId,
      streamName,
      startTime: startTimeMs,
      filePath,
      writeStream,
      bytesWritten: 0,
      isHandover: false,
      hourlyTimer,
    };

    this.sessions.set(recordingId, session);
    this.connToRecording.set(connId, recordingId);
    this.connToRecording.set(channelKey, recordingId);

    // Attach to StreamHub if channel is multiplexed
    try {
      const { streamHub } = await import('../multiplexer/stream-hub.ts');
      streamHub.attachDvr(sourceId, streamId, recordingId);
    } catch (err: any) {
      log(`[DVR] streamHub attach warning: ${err.message}`);
    }

    log(`[DVR] Started live recording for ${streamName} (id: ${recordingId}, conn: ${connId})`);

    // Notify Telegram of start
    sendTelegramNotification(
      `🔴 <b>Gecko DVR Aufnahme gestartet</b>\n` +
      `Sender: <b>${streamName}</b>\n` +
      `Startzeit: <code>${now.toLocaleTimeString()}</code>`
    ).catch(() => {});

    return {
      id: recordingId,
      userId,
      playlistId: conn.playlistName,
      sourceId,
      streamId,
      streamName,
      channelName: streamName,
      type: 'live',
      status: 'recording',
      startTime: startTimeIso,
      endTime: null,
      durationSeconds: 0,
      fileSizeBytes: 0,
      filePath,
      extra: { isHandover: false },
    };
  }

  /**
   * Periodic reminder that a recording is still running, so long recordings are
   * not forgotten (used by both stream-tee and server-side recordings).
   */
  private startHourlyReminder(recordingId: string, streamName: string): NodeJS.Timeout {
    const timer = setInterval(async () => {
      const session = this.sessions.get(recordingId);
      if (!session) return;
      const elapsedSec = Math.round((Date.now() - session.startTime) / 1000);
      const hours = (elapsedSec / 3600).toFixed(1);
      const sizeStr = formatBytes(session.bytesWritten);

      log(`[DVR] Hourly reminder for recording ${recordingId} (${streamName}) - running ${hours}h, ${sizeStr}`);
      await sendTelegramNotification(
        `⏳ <b>Gecko DVR Erinnerung</b>\n` +
        `Aufnahme für <b>${streamName}</b> läuft seit <b>${hours} Std.</b> (${sizeStr}).\n` +
        `Zum Stoppen im Gecko WebUI aufrufen.`
      );
    }, 60 * 60 * 1000);
    timer.unref?.();
    return timer;
  }

  /**
   * Starts a server-side recording of a live channel without any downstream client.
   *
   * The recorder opens an internal loopback request against the public proxy endpoint
   * so the complete upstream pipeline is reused: host failover, multi-IP pinning, VPN
   * routing, the unified concurrency guard and stream multiplexing. The proxy sees the
   * `x-gecko-dvr-recording-id` header and calls {@link attachExternalRecording} so the
   * resulting channel feeds this recording. The loopback response is drained purely to
   * keep the multiplexer happy — the actual file is written from the raw upstream chunks.
   *
   * @param durationMinutes Stop automatically after this many minutes; 0 records until stopped.
   */
  async startChannelRecording(opts: {
    playlistId: string;
    username: string;
    password: string;
    streamId: string;
    streamName?: string;
    userId: string;
    durationMinutes?: number;
    serverPort?: number;
  }): Promise<Recording> {
    const { playlistId, username, password, userId } = opts;
    const streamId = String(opts.streamId);
    const streamName = opts.streamName && opts.streamName.trim() ? opts.streamName.trim() : `Stream ${streamId}`;
    const durationMinutes = Number.isFinite(opts.durationMinutes) ? Math.max(0, Math.floor(opts.durationMinutes as number)) : 0;
    const serverPort = opts.serverPort || parseInt(process.env.PORT || '3000', 10);

    const recordingId = generateId();
    const filePath = path.join(RECORDINGS_DIR, `${recordingId}.ts`);
    const writeStream = fs.createWriteStream(filePath, { flags: 'a' });
    const startTimeMs = Date.now();

    const session: ActiveRecordingSession = {
      recordingId,
      connId: `dvr-${recordingId}`,
      userId,
      playlistId,
      sourceId: '',
      streamId,
      streamName,
      startTime: startTimeMs,
      filePath,
      writeStream,
      bytesWritten: 0,
      isHandover: false,
      hourlyTimer: this.startHourlyReminder(recordingId, streamName),
    };

    this.sessions.set(recordingId, session);
    this.connToRecording.set(recordingId, recordingId);
    this.connToRecording.set(session.connId, recordingId);

    const loopbackUrl = `http://127.0.0.1:${serverPort}/live/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${encodeURIComponent(streamId)}`;

    try {
      const response = await axios({
        method: 'get',
        url: loopbackUrl,
        responseType: 'stream',
        timeout: 60000,
        validateStatus: () => true,
        headers: {
          'User-Agent': 'Gecko-DVR/1.0',
          'x-gecko-dvr-recording-id': recordingId,
        },
      });

      if (response.status >= 400) {
        try { response.data.destroy(); } catch {}
        throw new Error(`Stream konnte nicht geöffnet werden (HTTP ${response.status}). Quelle möglicherweise belegt.`);
      }

      if (!this.sessions.has(recordingId) || !session.attached) {
        try { response.data.destroy(); } catch {}
        throw new Error(session.attachError || 'Aufnahme konnte nicht an den Stream angebunden werden.');
      }

      // Drain the loopback socket so the multiplexer does not flag a stalled subscriber.
      // The recording file itself is written from the raw upstream chunks in handleUpstreamChunk.
      session.abortUpstream = () => { try { response.data.destroy(); } catch {} };
      response.data.on('data', () => {});
      response.data.on('error', (err: any) => {
        if (this.sessions.has(recordingId)) {
          log(`[DVR] Loopback stream for ${recordingId} errored: ${err?.message || err}`);
        }
      });
      response.data.resume();

      // Schedule the requested duration (0 = run until manually stopped).
      if (durationMinutes > 0) {
        session.durationLimitTimer = setTimeout(() => {
          log(`[DVR] Duration limit (${durationMinutes} min) reached for ${recordingId} (${streamName}) — stopping.`);
          this.stopRecording(recordingId).catch((err: any) => log(`[DVR] Failed to stop recording ${recordingId} on duration limit: ${err.message}`));
        }, durationMinutes * 60 * 1000);
        session.durationLimitTimer.unref?.();
      }

      const startTimeIso = new Date(startTimeMs).toISOString();
      getDb().insert(recordings).values({
        id: recordingId,
        userId,
        playlistId,
        sourceId: session.sourceId,
        streamId: session.streamId,
        streamName,
        channelName: streamName,
        type: 'live',
        status: 'recording',
        startTime: startTimeIso,
        endTime: null,
        durationSeconds: 0,
        fileSizeBytes: 0,
        filePath,
        extra: { isHandover: false, manual: true, durationMinutes: durationMinutes || null },
      }).run();

      log(`[DVR] Started manual channel recording for ${streamName} (id: ${recordingId}, source: ${session.sourceId})`);

      sendTelegramNotification(
        `🔴 <b>Gecko DVR Aufnahme gestartet</b>\n` +
        `Sender: <b>${streamName}</b>\n` +
        `Startzeit: <code>${new Date(startTimeMs).toLocaleTimeString()}</code>\n` +
        `Dauer: ${durationMinutes > 0 ? `<b>${formatDuration(durationMinutes * 60)}</b>` : 'bis manuell gestoppt'}`
      ).catch(() => {});

      return this.getRecordingById(recordingId)!;
    } catch (err: any) {
      // Roll back the half-started session so it neither lingers nor blocks the source.
      await this.discardSession(recordingId);
      throw err;
    }
  }

  /**
   * Attaches a server-side recording to a live channel the proxy just opened or joined.
   * Called by the proxy when it sees the `x-gecko-dvr-recording-id` request header.
   */
  async attachExternalRecording(recordingId: string, sourceId: string, streamId: string, streamName: string): Promise<boolean> {
    const session = this.sessions.get(recordingId);
    if (!session) return false;

    if (!connectionArbiter.acquireDvrLock(sourceId, String(streamId), recordingId, streamName)) {
      session.attachError = 'Die Quelle ist bereits durch eine andere Aufnahme gesperrt.';
      log(`[DVR] Refused manual recording ${recordingId}: source ${sourceId} already locked by another recording.`);
      return false;
    }

    session.sourceId = sourceId;
    session.streamId = String(streamId);
    if (streamName) session.streamName = streamName;
    session.attached = true;
    this.connToRecording.set(`${sourceId}:${streamId}`, recordingId);

    try {
      const { streamHub } = await import('../multiplexer/stream-hub.ts');
      streamHub.attachDvr(sourceId, String(streamId), recordingId);
    } catch (err: any) {
      log(`[DVR] streamHub attach warning (external): ${err.message}`);
    }

    return true;
  }

  /**
   * Removes a session that never successfully started (failed attach or upstream open).
   */
  private async discardSession(recordingId: string): Promise<void> {
    const session = this.sessions.get(recordingId);
    if (!session) return;

    if (session.hourlyTimer) clearInterval(session.hourlyTimer);
    if (session.durationLimitTimer) clearTimeout(session.durationLimitTimer);
    try { session.abortUpstream?.(); } catch {}
    try { session.writeStream.destroy(); } catch {}

    this.connToRecording.delete(recordingId);
    this.connToRecording.delete(session.connId);
    if (session.sourceId) {
      this.connToRecording.delete(`${session.sourceId}:${session.streamId}`);
      connectionArbiter.releaseDvrLock(session.sourceId, recordingId);
      try {
        const { streamHub } = await import('../multiplexer/stream-hub.ts');
        streamHub.detachDvr(session.sourceId, session.streamId);
      } catch {}
    }

    this.sessions.delete(recordingId);
    try { if (fs.existsSync(session.filePath)) fs.unlinkSync(session.filePath); } catch {}
  }

  /**
   * Called on every chunk received by the proxy stream or multiplexer.
   */
  writeChunk(connIdOrKey: string, chunk: Buffer): void {
    const recordingId = this.connToRecording.get(connIdOrKey) || (this.sessions.has(connIdOrKey) ? connIdOrKey : undefined);
    if (!recordingId) return;

    const session = this.sessions.get(recordingId);
    if (!session || !session.writeStream.writable) return;

    session.writeStream.write(chunk);
    session.bytesWritten += chunk.length;
  }

  /**
   * Checks if a proxy connection is currently being recorded.
   */
  isRecordingConnection(connId: string): boolean {
    return this.connToRecording.has(connId);
  }

  /**
   * Handles client (TiviMate) disconnect.
   * If recording is active, initiates Handover: keeps upstream connection alive and alerts user via Telegram.
   * Returns true if handover occurred (meaning caller should NOT destroy upstream connection).
   */
  handleDownstreamClose(connIdOrRecordingId: string): boolean {
    const recordingId = this.connToRecording.get(connIdOrRecordingId) || (this.sessions.has(connIdOrRecordingId) ? connIdOrRecordingId : undefined);
    if (!recordingId) return false;

    const session = this.sessions.get(recordingId);
    if (!session) return false;

    // Prevent duplicate alerts if already in handover mode
    if (session.isHandover) {
      return true;
    }

    session.isHandover = true;
    session.handoverAt = Date.now();

    log(`[DVR] Handover activated for ${session.streamName} (${recordingId}). Client disconnected, keeping stream alive.`);

    // Update database extra
    try {
      const db = getDb();
      db.update(recordings)
        .set({
          extra: {
            isHandover: true,
            handoverAt: new Date().toISOString(),
          },
        })
        .where(eq(recordings.id, recordingId))
        .run();
    } catch (err: any) {
      log(`[DVR] Failed to update handover status in DB: ${err.message}`);
    }

    // Send immediate Telegram handover notification
    sendTelegramNotification(
      `⚠️ <b>Gecko DVR Handover</b>\n` +
      `Fernseher / Client hat Verbindung getrennt.\n` +
      `Die Aufnahme für <b>${session.streamName}</b> läuft im Hintergrund weiter!`
    ).catch(() => {});

    return true;
  }

  /**
   * Stops an active recording session.
   */
  async stopRecording(recordingId: string): Promise<Recording> {
    const session = this.sessions.get(recordingId);
    const db = getDb();

    if (session) {
      if (session.hourlyTimer) {
        clearInterval(session.hourlyTimer);
      }
      if (session.durationLimitTimer) {
        clearTimeout(session.durationLimitTimer);
      }

      // Close write stream
      await new Promise<void>((resolve) => {
        session.writeStream.end(() => resolve());
      });

      // Release arbiter lock
      connectionArbiter.releaseDvrLock(session.sourceId, recordingId);

      // Detach from StreamHub if channel was multiplexed
      try {
        const { streamHub } = await import('../multiplexer/stream-hub.ts');
        streamHub.detachDvr(session.sourceId, session.streamId);
      } catch (err: any) {
        log(`[DVR] streamHub detach warning: ${err.message}`);
      }

      // If connection was in handover, terminate upstream response and proxyStats
      if (session.isHandover && session.upstreamResponse) {
        if (session.upstreamResponse.data?.destroy) {
          session.upstreamResponse.data.destroy();
        }
      }

      // Remove from proxyStats if it was still there
      if (proxyStats.connections.has(session.connId)) {
        if (session.isHandover) {
          proxyStats.connections.delete(session.connId);
          proxyStats.activeStreams = Math.max(0, proxyStats.activeStreams - 1);
        } else {
          // Remove recording flag
          const conn = proxyStats.connections.get(session.connId);
          if (conn) delete (conn as any).recordingId;
        }
      }

      const now = new Date();
      const endTimeIso = now.toISOString();
      const durationSeconds = Math.max(1, Math.round((now.getTime() - session.startTime) / 1000));
      const fileSizeBytes = session.bytesWritten;

      // Update SQLite record
      db.update(recordings)
        .set({
          status: 'completed',
          endTime: endTimeIso,
          durationSeconds,
          fileSizeBytes,
          extra: {
            isHandover: session.isHandover,
            completedAt: endTimeIso,
          },
        })
        .where(eq(recordings.id, recordingId))
        .run();

      const channelKey = `${session.sourceId}:${session.streamId}`;
      this.connToRecording.delete(session.connId);
      this.connToRecording.delete(channelKey);
      this.sessions.delete(recordingId);

      // For server-side recordings, tear down the internal loopback request as well so
      // the multiplexer closes the upstream channel once the last subscriber is gone.
      try { session.abortUpstream?.(); } catch {}

      log(`[DVR] Stopped recording ${recordingId} for ${session.streamName} (${durationSeconds}s, ${fileSizeBytes} bytes)`);

      // Notify Telegram of completion
      sendTelegramNotification(
        `✅ <b>Gecko DVR Aufnahme beendet</b>\n` +
        `Sender: <b>${session.streamName}</b>\n` +
        `Dauer: <b>${formatDuration(durationSeconds)}</b>\n` +
        `Dateigröße: <b>${formatBytes(fileSizeBytes)}</b>`
      ).catch(() => {});

      return {
        id: recordingId,
        userId: session.userId,
        playlistId: session.playlistId,
        sourceId: session.sourceId,
        streamId: session.streamId,
        streamName: session.streamName,
        channelName: session.streamName,
        type: 'live',
        status: 'completed',
        startTime: new Date(session.startTime).toISOString(),
        endTime: endTimeIso,
        durationSeconds,
        fileSizeBytes,
        filePath: session.filePath,
        extra: { isHandover: session.isHandover },
      };
    }

    // Fallback: If session not in memory, check database
    const row = db.select().from(recordings).where(eq(recordings.id, recordingId)).get();
    if (!row) {
      throw new Error(`Recording ${recordingId} not found.`);
    }

    return {
      id: row.id,
      userId: row.userId,
      playlistId: row.playlistId || undefined,
      sourceId: row.sourceId,
      streamId: row.streamId,
      streamName: row.streamName,
      channelName: row.channelName || undefined,
      type: row.type as any,
      status: row.status as any,
      startTime: row.startTime,
      endTime: row.endTime,
      durationSeconds: row.durationSeconds,
      fileSizeBytes: row.fileSizeBytes,
      filePath: row.filePath,
      extra: row.extra as any,
    };
  }

  /**
   * Retrieves single recording by ID.
   */
  getRecordingById(recordingId: string): Recording | null {
    const session = this.sessions.get(recordingId);
    if (session) {
      const durationSeconds = Math.max(0, Math.round((Date.now() - session.startTime) / 1000));
      return {
        id: session.recordingId,
        userId: session.userId,
        playlistId: session.playlistId,
        sourceId: session.sourceId,
        streamId: session.streamId,
        streamName: session.streamName,
        channelName: session.streamName,
        type: 'live',
        status: 'recording',
        startTime: new Date(session.startTime).toISOString(),
        endTime: null,
        durationSeconds,
        fileSizeBytes: session.bytesWritten,
        filePath: session.filePath,
        extra: { isHandover: session.isHandover },
      };
    }

    const db = getDb();
    const row = db.select().from(recordings).where(eq(recordings.id, recordingId)).get();
    if (!row) return null;

    return {
      id: row.id,
      userId: row.userId,
      playlistId: row.playlistId || undefined,
      sourceId: row.sourceId,
      streamId: row.streamId,
      streamName: row.streamName,
      channelName: row.channelName || undefined,
      type: row.type as any,
      status: row.status as any,
      startTime: row.startTime,
      endTime: row.endTime,
      durationSeconds: row.durationSeconds,
      fileSizeBytes: row.fileSizeBytes,
      filePath: row.filePath,
      extra: row.extra as any,
    };
  }

  /**
   * Lists all recordings, augmenting active ones with real-time stats.
   */
  getAllRecordings(): Recording[] {
    const db = getDb();
    const rows = db.select().from(recordings).orderBy(desc(recordings.startTime)).all();

    return rows.map((row) => {
      const active = this.sessions.get(row.id);
      if (active) {
        const durationSeconds = Math.max(0, Math.round((Date.now() - active.startTime) / 1000));
        return {
          id: row.id,
          userId: row.userId,
          playlistId: row.playlistId || undefined,
          sourceId: row.sourceId,
          streamId: row.streamId,
          streamName: row.streamName,
          channelName: row.channelName || undefined,
          type: row.type as any,
          status: 'recording',
          startTime: row.startTime,
          endTime: null,
          durationSeconds,
          fileSizeBytes: active.bytesWritten,
          filePath: row.filePath,
          extra: { isHandover: active.isHandover },
        };
      }

      return {
        id: row.id,
        userId: row.userId,
        playlistId: row.playlistId || undefined,
        sourceId: row.sourceId,
        streamId: row.streamId,
        streamName: row.streamName,
        channelName: row.channelName || undefined,
        type: row.type as any,
        status: row.status as any,
        startTime: row.startTime,
        endTime: row.endTime,
        durationSeconds: row.durationSeconds,
        fileSizeBytes: row.fileSizeBytes,
        filePath: row.filePath,
        extra: row.extra as any,
      };
    });
  }

  /**
   * Recording sessions only exist in memory, so a restart leaves rows marked
   * `recording` whose recorder is gone. Left alone they show as "recording" in the
   * UI forever, keep the upstream connection alive with zero viewers, and keep a
   * client playback request open indefinitely. Finalise them once at startup.
   */
  reconcileOrphanedRecordings(): number {
    const db = getDb();
    const orphans = db.select().from(recordings).where(eq(recordings.status, 'recording')).all();

    for (const row of orphans) {
      let fileSizeBytes = row.fileSizeBytes ?? 0;
      if (row.filePath && fs.existsSync(row.filePath)) {
        fileSizeBytes = fs.statSync(row.filePath).size;
      }
      const endTimeIso = new Date().toISOString();
      const durationSeconds = Math.max(1, Math.round((Date.now() - new Date(row.startTime).getTime()) / 1000));

      db.update(recordings)
        .set({
          status: 'completed',
          endTime: endTimeIso,
          durationSeconds,
          fileSizeBytes,
          extra: { ...(row.extra as Record<string, unknown> | null), completedAt: endTimeIso, reconciledAtStartup: true },
        })
        .where(eq(recordings.id, row.id))
        .run();

      log(`[DVR] Reconciled orphaned recording ${row.id} (${row.streamName}) — marked completed at ${formatBytes(fileSizeBytes)}`);
    }

    return orphans.length;
  }

  /**
   * Deletes a recording and removes its file from disk.
   */
  async deleteRecording(recordingId: string): Promise<boolean> {
    if (this.sessions.has(recordingId)) {
      await this.stopRecording(recordingId);
    }

    const db = getDb();
    const row = db.select().from(recordings).where(eq(recordings.id, recordingId)).get();
    if (!row) return false;

    // Delete file from disk if it exists
    if (row.filePath && fs.existsSync(row.filePath)) {
      try {
        fs.unlinkSync(row.filePath);
        log(`[DVR] Deleted recording file ${row.filePath}`);
      } catch (err: any) {
        log(`[DVR] Failed to delete recording file ${row.filePath}: ${err.message}`);
      }
    }

    db.delete(recordings).where(eq(recordings.id, recordingId)).run();
    log(`[DVR] Deleted recording record ${recordingId}`);
    return true;
  }
}

export const dvrRecorder = new DvrRecorder();

// Hook into streamHub to receive multiplexed live stream chunks
import('../multiplexer/stream-hub.ts').then(({ streamHub }) => {
  streamHub.setOnChunk((channelKey: string, chunk: Buffer) => {
    dvrRecorder.writeChunk(channelKey, chunk);
  });
}).catch((err: any) => {
  log(`[DVR] Failed to hook streamHub onChunk: ${err.message}`);
});
