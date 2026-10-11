import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { connectDb, getDb } from '../db.ts';
import { recordings } from '../schema.ts';
import { dvrRecorder, RECORDINGS_DIR } from './recorder.ts';
import * as recorderModule from './recorder.ts';

describe('DVR Recording Repair & Backup Management', () => {
  const testRecId = 'test-repair-1234';
  const testFilePath = path.join(RECORDINGS_DIR, 'test_repair.ts');
  const backupFilePath = `${testFilePath}.orig.ts`;

  beforeEach(async () => {
    process.env.SQLITE_PATH = ':memory:';
    await connectDb();

    const db = getDb();
    db.delete(recordings).run();

    // Clean up any test files
    if (fs.existsSync(testFilePath)) fs.unlinkSync(testFilePath);
    if (fs.existsSync(backupFilePath)) fs.unlinkSync(backupFilePath);
  });

  afterEach(() => {
    if (fs.existsSync(testFilePath)) try { fs.unlinkSync(testFilePath); } catch {}
    if (fs.existsSync(backupFilePath)) try { fs.unlinkSync(backupFilePath); } catch {}
    vi.restoreAllMocks();
  });

  it('losslessly repairs recording, creates original backup with expiration, and updates database', async () => {
    const db = getDb();
    fs.writeFileSync(testFilePath, Buffer.from('ORIGINAL_DISCONTINUOUS_DATA'));

    db.insert(recordings).values({
      id: testRecId,
      userId: 'admin',
      sourceId: 'src-1',
      streamId: '100',
      streamName: 'Test Match',
      type: 'live',
      status: 'completed',
      startTime: '2026-10-11T14:00:00.000Z',
      endTime: '2026-10-11T17:30:00.000Z',
      durationSeconds: 95400, // inflated 26.5h
      fileSizeBytes: 1000,
      filePath: testFilePath,
      extra: { needsRepair: true },
    }).run();

    // Mock remux and probe to avoid requiring system ffmpeg during unit tests
    vi.spyOn(dvrRecorder, 'remuxLossless').mockImplementation(async (_inPath, outPath) => {
      fs.writeFileSync(outPath, Buffer.from('REPAIRED_CLEAN_DATA_MONOTONIC'));
    });
    vi.spyOn(dvrRecorder, 'probeDuration').mockResolvedValue(12600); // 3.5h

    const result = await dvrRecorder.repairRecording(testRecId);

    expect(result.durationSeconds).toBe(12600);
    expect(result.extra?.needsRepair).toBe(false);
    expect(result.extra?.backupPath).toBe(backupFilePath);
    expect(result.extra?.backupExpiresAt).toBeDefined();
    expect(result.extra?.originalDurationSeconds).toBe(95400);

    // Verify file system state:
    // 1. Original data was preserved in the backup file
    expect(fs.existsSync(backupFilePath)).toBe(true);
    expect(fs.readFileSync(backupFilePath).toString()).toBe('ORIGINAL_DISCONTINUOUS_DATA');

    // 2. Active file path now holds the repaired content
    expect(fs.existsSync(testFilePath)).toBe(true);
    expect(fs.readFileSync(testFilePath).toString()).toBe('REPAIRED_CLEAN_DATA_MONOTONIC');
  });

  it('reverts repaired recording back to original backup upon request', async () => {
    const db = getDb();
    fs.writeFileSync(testFilePath, Buffer.from('REPAIRED_DATA'));
    fs.writeFileSync(backupFilePath, Buffer.from('ORIGINAL_BACKUP_DATA'));

    db.insert(recordings).values({
      id: testRecId,
      userId: 'admin',
      sourceId: 'src-1',
      streamId: '100',
      streamName: 'Test Match',
      type: 'live',
      status: 'completed',
      startTime: '2026-10-11T14:00:00.000Z',
      endTime: '2026-10-11T17:30:00.000Z',
      durationSeconds: 12600,
      fileSizeBytes: 500,
      filePath: testFilePath,
      extra: {
        repairedAt: '2026-10-11T18:00:00.000Z',
        backupPath: backupFilePath,
        backupExpiresAt: '2026-10-14T18:00:00.000Z',
        originalDurationSeconds: 95400,
        originalFileSizeBytes: 1000,
      },
    }).run();

    const reverted = await dvrRecorder.revertRecording(testRecId);

    expect(reverted.durationSeconds).toBe(95400);
    expect(reverted.fileSizeBytes).toBe(1000);
    expect(reverted.extra?.backupPath).toBeUndefined();
    expect(reverted.extra?.backupExpiresAt).toBeUndefined();

    // Verify active file restored to original
    expect(fs.existsSync(testFilePath)).toBe(true);
    expect(fs.readFileSync(testFilePath).toString()).toBe('ORIGINAL_BACKUP_DATA');
    // Verify backup file was moved/consumed
    expect(fs.existsSync(backupFilePath)).toBe(false);
  });

  it('prunes expired original backup files without touching active recordings', async () => {
    const db = getDb();
    fs.writeFileSync(testFilePath, Buffer.from('ACTIVE_REPAIRED_CONTENT'));
    fs.writeFileSync(backupFilePath, Buffer.from('EXPIRED_ORIGINAL_BACKUP'));

    const expiredDate = new Date(Date.now() - 3600 * 1000).toISOString(); // 1 hour in the past

    db.insert(recordings).values({
      id: testRecId,
      userId: 'admin',
      sourceId: 'src-1',
      streamId: '100',
      streamName: 'Test Match',
      type: 'live',
      status: 'completed',
      startTime: '2026-10-05T14:00:00.000Z',
      endTime: '2026-10-05T17:30:00.000Z',
      durationSeconds: 12600,
      fileSizeBytes: 500,
      filePath: testFilePath,
      extra: {
        repairedAt: '2026-10-05T18:00:00.000Z',
        backupPath: backupFilePath,
        backupExpiresAt: expiredDate,
      },
    }).run();

    const prunedCount = dvrRecorder.pruneExpiredBackups();
    expect(prunedCount).toBe(1);

    // Backup must be gone
    expect(fs.existsSync(backupFilePath)).toBe(false);

    // Active repaired recording must remain 100% intact
    expect(fs.existsSync(testFilePath)).toBe(true);
    expect(fs.readFileSync(testFilePath).toString()).toBe('ACTIVE_REPAIRED_CONTENT');

    // DB metadata must be cleared
    const updated = dvrRecorder.getRecordingById(testRecId);
    expect(updated?.extra?.backupPath).toBeUndefined();
    expect(updated?.extra?.backupExpiresAt).toBeUndefined();
  });
});
