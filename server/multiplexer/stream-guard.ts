export type GuardAction = 'join_existing' | 'allow_new' | 'block_placeholder';

export interface GuardDecision {
  action: GuardAction;
  existingChannelKey?: string;
  reason?: string;
  activeStreamName?: string;
  activeStreamId?: string;
}

export interface StreamChannelSummary {
  channelKey: string;
  sourceId: string;
  streamId: string;
  streamName: string;
  subscriberCount: number;
  dvrRecordingId?: string;
}

/**
 * Checks if Concurrency Guard is enabled for a given source.
 * Defaults to true for single-connection (maxConnections <= 1) sources.
 */
export function isConcurrencyGuardEnabled(sourceDoc: any): boolean {
  if (sourceDoc?.concurrencyGuard !== undefined) {
    return Boolean(sourceDoc.concurrencyGuard);
  }
  const maxCons = parseInt(String(sourceDoc?.maxConnections ?? '1'), 10);
  return isNaN(maxCons) || maxCons <= 1;
}

/**
 * Evaluates whether an incoming stream request can be served directly, shared from
 * an existing stream, or must be blocked with a placeholder to protect the upstream account.
 */
export function evaluateStreamRequest(
  sourceDoc: any,
  requestedStreamId: string,
  activeChannelsOnSource: StreamChannelSummary[]
): GuardDecision {
  const reqId = String(requestedStreamId);

  // Check if this exact channel is ALREADY actively streaming from upstream
  const existingSameStream = activeChannelsOnSource.find(
    (c) => String(c.streamId) === reqId
  );

  if (existingSameStream) {
    return {
      action: 'join_existing',
      existingChannelKey: existingSameStream.channelKey,
      activeStreamName: existingSameStream.streamName,
      activeStreamId: existingSameStream.streamId,
    };
  }

  // If no other streams are active on this source, always allow opening
  if (activeChannelsOnSource.length === 0) {
    return { action: 'allow_new' };
  }

  // Source is active with DIFFERENT channel(s)
  const guardEnabled = isConcurrencyGuardEnabled(sourceDoc);
  const maxConnections = parseInt(String(sourceDoc?.maxConnections ?? '1'), 10) || 1;

  if (guardEnabled && activeChannelsOnSource.length >= maxConnections) {
    const primaryActive = activeChannelsOnSource[0];
    return {
      action: 'block_placeholder',
      activeStreamName: primaryActive.streamName,
      activeStreamId: primaryActive.streamId,
      reason: `Quelle ist durch "${primaryActive.streamName || primaryActive.streamId}" belegt (${maxConnections}-Verbindungs-Schutz aktiv).`,
    };
  }

  return { action: 'allow_new' };
}
