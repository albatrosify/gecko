import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PassThrough } from 'stream';
import { dvrRecorder, formatDuration } from './recorder.ts';
import { formatBytes } from '../utils.ts';
import { proxyStats } from '../proxy-stats.ts';
import { connectionArbiter } from './connection-arbiter.ts';
import axios from 'axios';

vi.mock('axios', () => ({
  default: vi.fn(),
}));

vi.mock('../logger.ts', () => ({
  log: vi.fn(),
}));

vi.mock('../telegram.ts', () => ({
  sendTelegramNotification: vi.fn().mockResolvedValue({ success: true }),
}));

// Mock DB
const mockInsertValues = vi.fn().mockReturnValue({ run: vi.fn() });
const mockUpdateSet = vi.fn().mockReturnValue({
  where: vi.fn().mockReturnValue({ run: vi.fn() }),
});

vi.mock('../db.ts', () => ({
  getDb: () => ({
    insert: () => ({ values: mockInsertValues }),
    update: () => ({ set: mockUpdateSet }),
    select: () => ({
      from: () => ({
        orderBy: () => ({ all: () => [] }),
        where: () => ({ get: () => null }),
      }),
    }),
    delete: () => ({
      where: () => ({ run: vi.fn() }),
    }),
  }),
  generateId: () => 'rec-test-123',
}));

describe('DvrRecorder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectionArbiter.reset();
    proxyStats.connections.clear();
  });

  it('formats bytes and duration accurately', () => {
    expect(formatBytes(500)).toBe('500 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1048576 * 2.5)).toBe('2.5 MB');
    expect(formatBytes(1073741824 * 3.25)).toBe('3.25 GB');

    expect(formatDuration(45)).toBe('0m 45s');
    expect(formatDuration(125)).toBe('2m 05s');
    expect(formatDuration(3665)).toBe('1h 01m 05s');
  });

  it('starts live recording from active proxy connection', async () => {
    const connId = 'conn-1';
    proxyStats.connections.set(connId, {
      id: connId,
      sourceId: 'source-1',
      streamId: '100',
      streamName: 'Das Erste HD',
      type: 'live',
    } as any);

    const recording = await dvrRecorder.startLiveRecordingFromConnection(connId, 'user-1');

    expect(recording.id).toBe('rec-test-123');
    expect(recording.status).toBe('recording');
    expect(recording.streamName).toBe('Das Erste HD');
    expect(dvrRecorder.isRecordingConnection(connId)).toBe(true);

    // Arbiter should hold lock
    expect(connectionArbiter.getSourceLock('source-1')).toBeDefined();
    expect(connectionArbiter.getSourceLock('source-1')?.streamId).toBe('100');
  });

  it('triggers handover when downstream disconnects', async () => {
    const connId = 'conn-2';
    proxyStats.connections.set(connId, {
      id: connId,
      sourceId: 'source-2',
      streamId: '200',
      streamName: 'ZDF HD',
      type: 'live',
    } as any);

    await dvrRecorder.startLiveRecordingFromConnection(connId, 'user-1');

    const handedOver = dvrRecorder.handleDownstreamClose(connId);
    expect(handedOver).toBe(true);

    const current = dvrRecorder.getRecordingById('rec-test-123');
    expect(current?.extra?.isHandover).toBe(true);
  });

  it('stops recording and releases lock', async () => {
    const connId = 'conn-3';
    proxyStats.connections.set(connId, {
      id: connId,
      sourceId: 'source-3',
      streamId: '300',
      streamName: 'RTL HD',
      type: 'live',
    } as any);

    await dvrRecorder.startLiveRecordingFromConnection(connId, 'user-1');
    expect(connectionArbiter.getSourceLock('source-3')).toBeDefined();

    const stopped = await dvrRecorder.stopRecording('rec-test-123');
    expect(stopped.status).toBe('completed');
    expect(dvrRecorder.isRecordingConnection(connId)).toBe(false);
    expect(connectionArbiter.getSourceLock('source-3')).toBeUndefined();
  });

  it('starts a server-side channel recording and attaches to the opened channel', async () => {
    // Simulate the proxy attaching this recording to the channel it just opened,
    // then delivering the loopback response (as handleStreamProxy would).
    (axios as any).mockImplementation(async () => {
      await dvrRecorder.attachExternalRecording('rec-test-123', 'source-manual', '100', 'Sport HD');
      const data = new PassThrough();
      return { status: 200, headers: {}, data };
    });

    const recording = await dvrRecorder.startChannelRecording({
      playlistId: 'playlist-1',
      username: 'user',
      password: 'pass',
      streamId: '100',
      streamName: 'Sport HD',
      userId: 'user-1',
      durationMinutes: 120,
    });

    expect(recording.id).toBe('rec-test-123');
    expect(recording.status).toBe('recording');
    expect(recording.sourceId).toBe('source-manual');
    expect(recording.streamName).toBe('Sport HD');
    expect(connectionArbiter.getSourceLock('source-manual')?.streamId).toBe('100');

    const stopped = await dvrRecorder.stopRecording('rec-test-123');
    expect(stopped.status).toBe('completed');
    expect(connectionArbiter.getSourceLock('source-manual')).toBeUndefined();
    expect(dvrRecorder.getRecordingById('rec-test-123')).toBeNull();
  });

  it('cleans up a server-side recording when the source is busy (HTTP 409)', async () => {
    (axios as any).mockResolvedValue({
      status: 409,
      headers: {},
      data: { destroy: vi.fn() },
    });

    await expect(dvrRecorder.startChannelRecording({
      playlistId: 'playlist-1',
      username: 'user',
      password: 'pass',
      streamId: '200',
      streamName: 'Busy Channel',
      userId: 'user-1',
      durationMinutes: 60,
    })).rejects.toThrow(/HTTP 409/);

    // Identified itself as a DVR request to the loopback proxy.
    const call = (axios as any).mock.calls[0][0];
    expect(call.headers['x-gecko-dvr-recording-id']).toBe('rec-test-123');
    expect(call.url).toContain('/live/user/pass/200');

    // No lingering session and nothing left behind.
    expect(dvrRecorder.getRecordingById('rec-test-123')).toBeNull();
  });
});
