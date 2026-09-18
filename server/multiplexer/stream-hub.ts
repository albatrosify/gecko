import express from 'express';
import { log } from '../logger.ts';
import { proxyStats } from '../proxy-stats.ts';
import { StreamChannelSummary } from './stream-guard.ts';

export interface DownstreamSubscriber {
  id: string;
  req?: express.Request;
  res: express.Response;
  username: string;
  playlistName: string;
  ip: string;
  startTime: number;
}

export interface ActiveStreamChannel {
  channelKey: string;
  sourceId: string;
  streamId: string;
  streamName: string;
  type: 'live' | 'movie' | 'series';
  hostUrl: string;
  upstreamResponse: any;
  subscribers: Map<string, DownstreamSubscriber>;
  bytesRead: number;
  startTime: number;
  dvrRecordingId?: string;
  headersSent?: Record<string, any>;
}

export type ChunkCallback = (channelKey: string, chunk: Buffer) => void;

class StreamHub {
  private channels = new Map<string, ActiveStreamChannel>(); // channelKey -> ActiveStreamChannel
  private onChunkCallback?: ChunkCallback;

  setOnChunk(callback: ChunkCallback): void {
    this.onChunkCallback = callback;
  }

  static makeKey(sourceId: string, streamId: string): string {
    return `${sourceId}:${streamId}`;
  }

  hasChannel(sourceId: string, streamId: string): boolean {
    return this.channels.has(StreamHub.makeKey(sourceId, streamId));
  }

  getChannel(sourceId: string, streamId: string): ActiveStreamChannel | undefined {
    return this.channels.get(StreamHub.makeKey(sourceId, streamId));
  }

  getChannelByKey(channelKey: string): ActiveStreamChannel | undefined {
    return this.channels.get(channelKey);
  }

  getActiveChannelsForSource(sourceId: string): StreamChannelSummary[] {
    const list: StreamChannelSummary[] = [];
    for (const channel of this.channels.values()) {
      if (channel.sourceId === sourceId) {
        list.push({
          channelKey: channel.channelKey,
          sourceId: channel.sourceId,
          streamId: channel.streamId,
          streamName: channel.streamName,
          subscriberCount: channel.subscribers.size,
          dvrRecordingId: channel.dvrRecordingId,
        });
      }
    }
    return list;
  }

  /**
   * Registers a new active upstream channel ingestion pipeline.
   */
  registerChannel(
    sourceId: string,
    streamId: string,
    streamName: string,
    type: 'live' | 'movie' | 'series',
    hostUrl: string,
    upstreamResponse: any,
    headersSent?: Record<string, any>
  ): ActiveStreamChannel {
    const channelKey = StreamHub.makeKey(sourceId, streamId);

    // If channel already exists, destroy the old one first
    if (this.channels.has(channelKey)) {
      this.closeChannel(channelKey);
    }

    const channel: ActiveStreamChannel = {
      channelKey,
      sourceId,
      streamId,
      streamName,
      type,
      hostUrl,
      upstreamResponse,
      subscribers: new Map(),
      bytesRead: 0,
      startTime: Date.now(),
      headersSent,
    };

    this.channels.set(channelKey, channel);

    // Broadcast incoming upstream chunks
    upstreamResponse.data.on('data', async (chunk: Buffer) => {
      channel.bytesRead += chunk.length;
      proxyStats.totalBytes += chunk.length;
      proxyStats.intervalBytes += chunk.length;

      // Broadcast to all active downstream subscribers
      for (const [subId, sub] of Array.from(channel.subscribers.entries())) {
        if (sub.res.writableEnded || sub.res.destroyed || (sub.req && sub.req.destroyed) || sub.res.writable === false) {
          this.removeSubscriber(channelKey, subId);
          continue;
        }

        try {
          const ok = sub.res.write(chunk);
          const conn = proxyStats.connections.get(subId);
          if (conn) {
            conn.bytesRead += chunk.length;
            conn.intervalBytes += chunk.length;
          }
          if (!ok && (sub.res.destroyed || sub.res.writableEnded)) {
            this.removeSubscriber(channelKey, subId);
          }
        } catch (err: any) {
          log(`[StreamHub] Error writing to subscriber ${subId}: ${err.message}`);
          this.removeSubscriber(channelKey, subId);
        }
      }

      // If DVR recording attached, write chunk to recording file
      if (channel.dvrRecordingId && this.onChunkCallback) {
        try {
          this.onChunkCallback(channelKey, chunk);
        } catch (err: any) {
          log(`[StreamHub] DVR chunk error: ${err.message}`);
        }
      }
    });

    // Handle upstream stream completion or error
    const handleUpstreamEnd = () => {
      log(`[StreamHub] Upstream closed for ${channelKey}`);
      this.closeChannel(channelKey);
    };
    upstreamResponse.data.on('end', handleUpstreamEnd);
    upstreamResponse.data.on('error', handleUpstreamEnd);

    log(`[StreamHub] Registered new active channel: ${channelKey} (${streamName})`);
    return channel;
  }

  /**
   * Subscribes a downstream client to an active channel.
   */
  addSubscriber(
    channelKey: string,
    sub: DownstreamSubscriber
  ): boolean {
    const channel = this.channels.get(channelKey);
    if (!channel) return false;

    // Set forward headers on downstream response
    if (channel.headersSent) {
      for (const [header, val] of Object.entries(channel.headersSent)) {
        if (val) sub.res.setHeader(header, val);
      }
    }
    sub.res.setHeader('Content-Type', 'video/mp2t');
    sub.res.setHeader('Connection', 'keep-alive');
    sub.res.setHeader('Cache-Control', 'no-cache, no-store');

    channel.subscribers.set(sub.id, sub);

    // Track connection in proxyStats
    const connectionInfo = {
      id: sub.id,
      channelKey,
      sourceId: channel.sourceId,
      host: channel.hostUrl,
      username: sub.username,
      streamId: channel.streamId,
      streamName: channel.streamName,
      playlistName: sub.playlistName,
      type: channel.type,
      ip: sub.ip,
      startTime: sub.startTime,
      bytesRead: 0,
      intervalBytes: 0,
      currentBps: 0,
      proxied: true,
      subscriberCount: channel.subscribers.size,
      recordingId: channel.dvrRecordingId,
    };
    proxyStats.connections.set(sub.id, connectionInfo as any);
    proxyStats.activeStreams++;

    // Update subscriberCount on all sibling subscribers in proxyStats
    this.syncSubscriberCount(channel);

    // If there was a DVR Handover connection card in proxyStats, remove it because human viewer has joined!
    if (channel.dvrRecordingId) {
      const handoverConnId = `dvr-${channel.dvrRecordingId}`;
      if (proxyStats.connections.has(handoverConnId)) {
        proxyStats.connections.delete(handoverConnId);
        proxyStats.activeStreams = Math.max(0, proxyStats.activeStreams - 1);
      }
    }

    // Handle subscriber disconnect (guaranteed idempotent across req & res)
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      try { sub.res.destroy(); } catch {}
      this.removeSubscriber(channelKey, sub.id);
    };
    if (sub.req) {
      sub.req.on('close', cleanup);
      sub.req.on('end', cleanup);
      sub.req.socket?.on('close', cleanup);
      sub.req.socket?.on('error', cleanup);
    }
    sub.res.on('finish', cleanup);
    sub.res.on('close', cleanup);
    sub.res.on('error', cleanup);

    log(`[StreamHub] Subscriber ${sub.id} joined ${channelKey} (${channel.subscribers.size} active viewers on this stream)`);
    return true;
  }

  /**
   * Removes a downstream client from an active channel.
   */
  async removeSubscriber(channelKey: string, subId: string): Promise<void> {
    const channel = this.channels.get(channelKey);
    if (!channel) return;

    if (channel.subscribers.has(subId)) {
      channel.subscribers.delete(subId);

      if (proxyStats.connections.has(subId)) {
        proxyStats.connections.delete(subId);
        proxyStats.activeStreams = Math.max(0, proxyStats.activeStreams - 1);
      }

      this.syncSubscriberCount(channel);
      log(`[StreamHub] Subscriber ${subId} left ${channelKey} (${channel.subscribers.size} remaining viewers)`);
    }

    // Check if any viewers remain
    if (channel.subscribers.size === 0) {
      if (channel.dvrRecordingId) {
        // DVR Handover: Keep upstream alive for recording!
        log(`[StreamHub] All viewers left ${channelKey}, but DVR is recording (${channel.dvrRecordingId}). Stream kept alive.`);
        const { dvrRecorder } = await import('../dvr/recorder.ts');
        dvrRecorder.handleDownstreamClose(channel.dvrRecordingId);

        // Add a Handover entry to proxyStats so the dashboard clearly shows that the stream is recording in background!
        const handoverConnId = `dvr-${channel.dvrRecordingId}`;
        if (!proxyStats.connections.has(handoverConnId)) {
          proxyStats.connections.set(handoverConnId, {
            id: handoverConnId,
            channelKey,
            sourceId: channel.sourceId,
            host: channel.hostUrl,
            username: 'Gecko DVR',
            streamId: channel.streamId,
            streamName: channel.streamName,
            playlistName: '📁 Gecko DVR (Handover)',
            type: channel.type,
            ip: '127.0.0.1',
            startTime: channel.startTime,
            bytesRead: channel.bytesRead,
            intervalBytes: 0,
            currentBps: 0,
            proxied: true,
            subscriberCount: 0,
            recordingId: channel.dvrRecordingId,
            isHandover: true,
          } as any);
          proxyStats.activeStreams++;
        }
      } else {
        // No viewers and no DVR -> Tear down upstream connection
        log(`[StreamHub] No viewers left for ${channelKey}. Tearing down upstream connection.`);
        this.closeChannel(channelKey);
      }
    }
  }

  /**
   * Attaches a DVR recording to an active stream channel.
   */
  attachDvr(sourceId: string, streamId: string, recordingId: string): boolean {
    const channelKey = StreamHub.makeKey(sourceId, streamId);
    const channel = this.channels.get(channelKey);
    if (!channel) return false;

    channel.dvrRecordingId = recordingId;
    this.syncRecordingId(channel, recordingId);
    log(`[StreamHub] Attached DVR recording ${recordingId} to active channel ${channelKey}`);
    return true;
  }

  /**
   * Detaches a DVR recording from an active stream channel.
   */
  detachDvr(sourceId: string, streamId: string): void {
    const channelKey = StreamHub.makeKey(sourceId, streamId);
    const channel = this.channels.get(channelKey);
    if (!channel) return;

    const oldDvrId = channel.dvrRecordingId;
    if (oldDvrId) {
      const handoverConnId = `dvr-${oldDvrId}`;
      if (proxyStats.connections.has(handoverConnId)) {
        proxyStats.connections.delete(handoverConnId);
        proxyStats.activeStreams = Math.max(0, proxyStats.activeStreams - 1);
      }
    }
    channel.dvrRecordingId = undefined;
    this.syncRecordingId(channel, undefined);
    log(`[StreamHub] Detached DVR from channel ${channelKey}`);

    // If no human viewers are left either, close upstream connection
    if (channel.subscribers.size === 0) {
      log(`[StreamHub] No viewers remaining after DVR stop. Closing channel ${channelKey}.`);
      this.closeChannel(channelKey);
    }
  }

  /**
   * Completely closes and tears down an active channel.
   */
  closeChannel(channelKey: string): void {
    const channel = this.channels.get(channelKey);
    if (!channel) return;

    // If a DVR recording was attached when channel closes, stop and finalize recording session
    if (channel.dvrRecordingId) {
      const recId = channel.dvrRecordingId;
      channel.dvrRecordingId = undefined;
      const handoverConnId = `dvr-${recId}`;
      if (proxyStats.connections.has(handoverConnId)) {
        proxyStats.connections.delete(handoverConnId);
        proxyStats.activeStreams = Math.max(0, proxyStats.activeStreams - 1);
      }
      import('../dvr/recorder.ts').then(({ dvrRecorder }) => {
        dvrRecorder.stopRecording(recId).catch(err => {
          log(`[StreamHub] Failed to finalize DVR recording ${recId} on channel close: ${err.message}`);
        });
      }).catch((err) => {
        log(`[StreamHub] Failed to load DVR recorder while finalizing ${recId}: ${err?.message ?? err}`);
      });
    }

    // Close all remaining subscriber connections
    for (const sub of channel.subscribers.values()) {
      if (!sub.res.writableEnded && !sub.res.destroyed) {
        try {
          sub.res.end();
        } catch {}
      }
      if (proxyStats.connections.has(sub.id)) {
        proxyStats.connections.delete(sub.id);
        proxyStats.activeStreams = Math.max(0, proxyStats.activeStreams - 1);
      }
    }
    channel.subscribers.clear();

    // Destroy upstream response
    if (channel.upstreamResponse?.data?.destroy) {
      channel.upstreamResponse.data.destroy();
    }

    this.channels.delete(channelKey);
    log(`[StreamHub] Channel ${channelKey} closed.`);
  }

  private syncSubscriberCount(channel: ActiveStreamChannel) {
    const count = channel.subscribers.size;
    for (const sub of channel.subscribers.values()) {
      const conn = proxyStats.connections.get(sub.id);
      if (conn) {
        (conn as any).subscriberCount = count;
      }
    }
  }

  private syncRecordingId(channel: ActiveStreamChannel, recordingId?: string) {
    for (const sub of channel.subscribers.values()) {
      const conn = proxyStats.connections.get(sub.id);
      if (conn) {
        if (recordingId) {
          (conn as any).recordingId = recordingId;
        } else {
          delete (conn as any).recordingId;
        }
      }
    }
  }

  reset(): void {
    for (const key of Array.from(this.channels.keys())) {
      this.closeChannel(key);
    }
  }
}

export const streamHub = new StreamHub();
