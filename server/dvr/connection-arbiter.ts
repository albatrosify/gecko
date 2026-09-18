import { log } from '../logger.ts';

export interface DvrSourceLock {
  sourceId: string;
  streamId: string;
  streamName?: string;
  recordingId: string;
  lockedAt: number;
}

export interface PlaybackDecision {
  allowed: boolean;
  isSharedDvr?: boolean;
  lock?: DvrSourceLock;
  reason?: string;
}

class ConnectionArbiter {
  private locks = new Map<string, DvrSourceLock>();

  /**
   * Attempts to acquire an exclusive DVR lock for an upstream source.
   */
  acquireDvrLock(
    sourceId: string,
    streamId: string,
    recordingId: string,
    streamName?: string
  ): boolean {
    const existing = this.locks.get(sourceId);
    if (existing) {
      if (existing.recordingId === recordingId) {
        return true; // Already held by same recording
      }
      log(`[Arbiter] Lock rejected for source ${sourceId}: already locked by recording ${existing.recordingId}`);
      return false;
    }

    const lock: DvrSourceLock = {
      sourceId,
      streamId,
      streamName,
      recordingId,
      lockedAt: Date.now(),
    };
    this.locks.set(sourceId, lock);
    log(`[Arbiter] Acquired DVR lock for source ${sourceId} (stream: ${streamId}, rec: ${recordingId})`);
    return true;
  }

  /**
   * Releases an exclusive DVR lock for an upstream source.
   */
  releaseDvrLock(sourceId: string, recordingId: string): boolean {
    const existing = this.locks.get(sourceId);
    if (!existing) return false;
    if (existing.recordingId !== recordingId) {
      log(`[Arbiter] Cannot release lock for source ${sourceId}: held by ${existing.recordingId}, not ${recordingId}`);
      return false;
    }

    this.locks.delete(sourceId);
    log(`[Arbiter] Released DVR lock for source ${sourceId} (rec: ${recordingId})`);
    return true;
  }

  /**
   * Returns current DVR lock for a source if active.
   */
  getSourceLock(sourceId: string): DvrSourceLock | undefined {
    return this.locks.get(sourceId);
  }

  /**
   * Evaluates if a downstream client can stream the requested channel.
   * If the source is DVR locked:
   * - If the requested stream matches the DVR stream -> allowed with isSharedDvr = true.
   * - If the requested stream is different -> denied (will route to placeholder).
   */
  canPlayStream(sourceId: string, requestedStreamId: string): PlaybackDecision {
    const lock = this.locks.get(sourceId);
    if (!lock) {
      return { allowed: true };
    }

    // Matching stream -> share existing connection
    if (String(lock.streamId) === String(requestedStreamId)) {
      return {
        allowed: true,
        isSharedDvr: true,
        lock,
      };
    }

    // Different stream -> conflict with 1-connection limit
    return {
      allowed: false,
      isSharedDvr: false,
      lock,
      reason: `Source ${sourceId} is locked by active DVR recording for stream ${lock.streamName || lock.streamId}`,
    };
  }

  /**
   * Clears all locks (e.g. on server shutdown or reset).
   */
  reset(): void {
    this.locks.clear();
  }
}

export const connectionArbiter = new ConnectionArbiter();
