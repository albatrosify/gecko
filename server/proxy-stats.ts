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

/**
 * Kill switches for active proxied streams, keyed by the same id used in
 * `proxyStats.connections`. Every teardown path (subscriber, 1:1 pipe,
 * placeholder) registers a closure that fully tears the stream down; the
 * Dashboard's "Trennen" buttons call `killStream()` on it.
 */
export const streamControllers = new Map<string, () => void>();

export function registerStreamController(id: string, kill: () => void): void {
  streamControllers.set(id, kill);
}

export function unregisterStreamController(id: string): void {
  streamControllers.delete(id);
}

/** Force-tears down a single active stream. Returns false if it was already gone. */
export function killStream(id: string): boolean {
  const kill = streamControllers.get(id);
  if (!kill) return false;
  streamControllers.delete(id);
 try {
    kill();
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

let statsInterval: NodeJS.Timeout | null = null;

// Update bits per second regularly and keep a history
export function initProxyStatsInterval() {
  if (statsInterval) clearInterval(statsInterval);
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
