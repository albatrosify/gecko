export const proxyStats = {
  activeStreams: 0,
  totalBytes: 0,
  currentBps: 0,
  lastCheck: Date.now(),
  intervalBytes: 0,
  history: [] as { time: number; bps: number }[],
  connections: new Map<string, {
    id: string;
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
  }>()
};

// Update bits per second regularly and keep a history
export function initProxyStatsInterval() {
  setInterval(() => {
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
}
