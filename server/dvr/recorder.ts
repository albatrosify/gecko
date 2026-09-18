import fs from 'fs';
import path from 'path';
import { getDb, generateId } from '../db.ts';
import { recordings } from '../schema.ts';
import { log } from '../logger.ts';
import { proxyStats } from '../proxy-stats.ts';
import { connectionArbiter } from './connection-arbiter.ts';
import { sendTelegramNotification } from '../telegram.ts';
import { eq, desc } from 'drizzle-orm';
import { Recording } from '../../src/types.ts';

export const RECORDINGS_DIR = process.env.DVR_STORAGE_PATH || path.join(process.cwd(), 'data', 'recordings');

// Ensure recordings storage directory exists
if (!fs.existsSync(RECORDINGS_DIR)) {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
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
  upstreamResponse?: any;
}

class DvrRecorder {
  private sessions = new Map<string, ActiveRecordingSession>(); // recordingId -> session
  private connToRecording = new Map<string, string>(); // connId -> recordingId

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
    const hourlyTimer = setInterval(async () => {
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
    hourlyTimer.unref?.();

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
   * Stores the upstream response object so it can be kept alive during handover or closed on stop.
   */
  setUpstreamResponse(connId: string, response: any): void {
    const recordingId = this.connToRecording.get(connId);
    if (!recordingId) return;

    const session = this.sessions.get(recordingId);
    if (session) {
      session.upstreamResponse = response;
    }
  }

  /**
   * Checks if a proxy connection is currently being recorded.
   */
  isRecordingConnection(connId: string): boolean {
    return this.connToRecording.has(connId);
  }

  /**
   * Gets recording ID for a connection.
   */
  getRecordingIdForConnection(connId: string): string | undefined {
    return this.connToRecording.get(connId);
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
