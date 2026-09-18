import { describe, it, expect } from 'vitest';
import { evaluateStreamRequest, isConcurrencyGuardEnabled } from './stream-guard.ts';

describe('StreamGuard', () => {
  it('enables guard by default for 1-connection accounts', () => {
    expect(isConcurrencyGuardEnabled({ maxConnections: 1 })).toBe(true);
    expect(isConcurrencyGuardEnabled({ maxConnections: '1' })).toBe(true);
    expect(isConcurrencyGuardEnabled({})).toBe(true);
    expect(isConcurrencyGuardEnabled({ maxConnections: 2 })).toBe(false);
  });

  it('respects explicit concurrencyGuard setting', () => {
    expect(isConcurrencyGuardEnabled({ maxConnections: 1, concurrencyGuard: false })).toBe(false);
    expect(isConcurrencyGuardEnabled({ maxConnections: 2, concurrencyGuard: true })).toBe(true);
  });

  it('allows opening new stream when source is completely idle', () => {
    const decision = evaluateStreamRequest({ id: 's1', maxConnections: 1 }, '100', []);
    expect(decision.action).toBe('allow_new');
  });

  it('routes to join_existing when the requested stream is already active', () => {
    const active = [
      {
        channelKey: 's1:100',
        sourceId: 's1',
        streamId: '100',
        streamName: 'Das Erste HD',
        subscriberCount: 1,
      },
    ];

    const decision = evaluateStreamRequest({ id: 's1', maxConnections: 1 }, '100', active);
    expect(decision.action).toBe('join_existing');
    expect(decision.existingChannelKey).toBe('s1:100');
  });

  it('blocks and serves placeholder when source is at capacity on a different stream with guard enabled', () => {
    const active = [
      {
        channelKey: 's1:100',
        sourceId: 's1',
        streamId: '100',
        streamName: 'Das Erste HD',
        subscriberCount: 1,
      },
    ];

    const decision = evaluateStreamRequest({ id: 's1', maxConnections: 1 }, '200', active);
    expect(decision.action).toBe('block_placeholder');
    expect(decision.activeStreamName).toBe('Das Erste HD');
    expect(decision.reason).toContain('1-Verbindungs-Schutz');
  });

  it('allows second stream if concurrencyGuard is explicitly disabled', () => {
    const active = [
      {
        channelKey: 's1:100',
        sourceId: 's1',
        streamId: '100',
        streamName: 'Das Erste HD',
        subscriberCount: 1,
      },
    ];

    const decision = evaluateStreamRequest({ id: 's1', maxConnections: 1, concurrencyGuard: false }, '200', active);
    expect(decision.action).toBe('allow_new');
  });
});
