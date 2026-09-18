import { describe, it, expect, beforeEach, vi } from 'vitest';
import { connectionArbiter } from './connection-arbiter.ts';

vi.mock('../logger.ts', () => ({
  log: vi.fn(),
}));

describe('ConnectionArbiter', () => {
  beforeEach(() => {
    connectionArbiter.reset();
  });

  it('allows playing when source is not locked', () => {
    const decision = connectionArbiter.canPlayStream('source-1', '101');
    expect(decision.allowed).toBe(true);
    expect(decision.isSharedDvr).toBeUndefined();
  });

  it('acquires and releases DVR lock successfully', () => {
    const acquired = connectionArbiter.acquireDvrLock('source-1', '101', 'rec-abc', 'ARD HD');
    expect(acquired).toBe(true);
    expect(connectionArbiter.getSourceLock('source-1')?.streamId).toBe('101');

    // Reject second lock from different recording
    const secondAcquire = connectionArbiter.acquireDvrLock('source-1', '102', 'rec-xyz');
    expect(secondAcquire).toBe(false);

    // Release lock
    const released = connectionArbiter.releaseDvrLock('source-1', 'rec-abc');
    expect(released).toBe(true);
    expect(connectionArbiter.getSourceLock('source-1')).toBeUndefined();
  });

  it('allows same channel playback as shared DVR stream', () => {
    connectionArbiter.acquireDvrLock('source-1', '101', 'rec-abc', 'ARD HD');

    const decision = connectionArbiter.canPlayStream('source-1', '101');
    expect(decision.allowed).toBe(true);
    expect(decision.isSharedDvr).toBe(true);
    expect(decision.lock?.streamId).toBe('101');
  });

  it('denies different channel playback when source is locked', () => {
    connectionArbiter.acquireDvrLock('source-1', '101', 'rec-abc', 'ARD HD');

    const decision = connectionArbiter.canPlayStream('source-1', '999');
    expect(decision.allowed).toBe(false);
    expect(decision.isSharedDvr).toBe(false);
    expect(decision.reason).toContain('locked by active DVR recording');
  });

  it('does not release lock if recordingId does not match', () => {
    connectionArbiter.acquireDvrLock('source-1', '101', 'rec-abc', 'ARD HD');
    const released = connectionArbiter.releaseDvrLock('source-1', 'wrong-rec-id');
    expect(released).toBe(false);
    expect(connectionArbiter.getSourceLock('source-1')).toBeDefined();
  });
});
