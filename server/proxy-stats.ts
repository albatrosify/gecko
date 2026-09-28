export const proxyStats = {
  activeStreams: 0,
  totalBytes: 0,
  currentBps: 0,
  lastCheck: Date.now(),
  intervalBytes: 0,
  history: [] as { time: number; bps: number }[],
  connections: new Map<string, {
    id: string;
    sourceId?: string;
    playlistId?: string;
    username: string;
    streamId: string;
    streamName: string;
    playlistName: string;
    type: string;
    ip: string;
    startTime: number;
    bytesRead: number;
    intervalBytes: number;
    currentBps: number;
    proxied: boolean;
    channelKey?: string;
    subscriberCount?: number;
    recordingId?: string;
    isPlaceholder?: boolean;
    isHandover?: boolean;
  }>()
};

export interface StreamController {
  kill: () => void;
  isAlive?: () => boolean;
}

/**
 * Kill switches for active proxied streams, keyed by the same id used in
 * `proxyStats.connections`. Every teardown path (subscriber, 1:1 pipe,
 * placeholder) registers a closure that fully tears the stream down; the
 * Dashboard's "Trennen" buttons call `killStream()` on it.
 */
export const streamControllers = new Map<string, StreamController>();

export function registerStreamController(id: string, kill: () => void, isAlive?: () => boolean): void {
  streamControllers.set(id, { kill, isAlive });
}

export function unregisterStreamController(id: string): void {
  streamControllers.delete(id);
}

/** Force-tears down a single active stream. Returns false if it was already gone. */
export function killStream(id: string): boolean {
  const ctrl = streamControllers.get(id);
  if (!ctrl) return false;
  streamControllers.delete(id);
  try {
    ctrl.kill();
  } catch {
    // Teardown is best-effort; the connection entry is dropped regardless.
  }
  return true;
}

/** Force-tears down every active stream. Returns the number of streams killed. */
export function killAllStreams(): number {
  let count = 0;
  for (const id of Array.from(streamControllers.keys())) {
    if (killStream(id)) count++;
  }
  return count;
}

/**
 * Returns all active 1:1 (VOD / Timeshift) connections for a given source that consume
 * an upstream connection slot (i.e. not multiplexed through StreamHub and not placeholders).
 */
export function getActiveVodConnectionsForSource(sourceId: string): Array<{
  id: string;
  streamId: string;
  streamName: string;
  username: string;
  playlistId?: string;
  type: string;
  ip: string;
}> {
  const result: Array<{
    id: string;
    streamId: string;
    streamName: string;
    username: string;
    playlistId?: string;
    type: string;
    ip: string;
  }> = [];

  for (const conn of proxyStats.connections.values()) {
    if (
      conn.sourceId === sourceId &&
      !conn.channelKey &&
      !conn.isPlaceholder &&
      !conn.isHandover &&
      conn.proxied
    ) {
      result.push({
        id: conn.id,
        streamId: conn.streamId,
        streamName: conn.streamName,
        username: conn.username,
        playlistId: conn.playlistId,
        type: conn.type,
        ip: conn.ip,
      });
    }
  }
  return result;
}

let statsInterval: NodeJS.Timeout | null = null;
let sweepTick = 0;

// Update bits per second regularly and keep a history
export function initProxyStatsInterval() {
  if (statsInterval) clearInterval(statsInterval);
  sweepTick = 0;
  statsInterval = setInterval(() => {
    const now = Date.now();
    const elapsed = (now - proxyStats.lastCheck) / 1000;
    if (elapsed > 0) {
      proxyStats.currentBps = (proxyStats.intervalBytes * 8) / elapsed;
      proxyStats.intervalBytes = 0;
      proxyStats.lastCheck = now;

      // Update per-connection bandwidth
      for (const conn of proxyStats.connections.values()) {
        conn.currentBps = (conn.intervalBytes * 8) / elapsed;
        conn.intervalBytes = 0;
      }

      // Keep 60 points of history (2 minutes at 2s intervals)
      proxyStats.history.push({ time: now, bps: proxyStats.currentBps });
      if (proxyStats.history.length > 60) proxyStats.history.shift();

      // Periodic zombie socket sweeper (runs every 10s / 5 ticks)
      sweepTick = (sweepTick + 1) % 5;
      if (sweepTick === 0) {
        for (const [id, conn] of Array.from(proxyStats.connections.entries())) {
          const ctrl = streamControllers.get(id);
          if (!ctrl) {
            // Orphan entry in proxyStats with no controller
            proxyStats.connections.delete(id);
            proxyStats.activeStreams = Math.max(0, proxyStats.activeStreams - 1);
            continue;
          }
          if (ctrl.isAlive && !ctrl.isAlive()) {
            // Underlying socket/response ended without event firing
            killStream(id);
          }
        }
      }
    }
  }, 2000);
  statsInterval.unref?.();
}

export function stopProxyStatsInterval() {
  if (statsInterval) {
    clearInterval(statsInterval);
    statsInterval = null;
  }
}
