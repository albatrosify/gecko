import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Covers the ADR 0002 upgrade cleanup: an install that predates the normalised
 * catalog still has the old stream blobs and snapshots on disk, and `connectDb()`
 * removes them while leaving sync cooldowns and the category snapshot alone.
 *
 * Uses a real file (not `:memory:`) because the cleanup has to be observed
 * across two `connectDb()` calls against the same database.
 */
const dbPath = path.join(os.tmpdir(), `gecko-migration-${process.pid}-${Date.now()}.db`);
process.env.SQLITE_PATH = dbPath;

const { connectDb, getSqlite } = await import('./db.ts');

function seedLegacyRows(): void {
  const sqlite = getSqlite();
  const now = Date.now();
  const cacheKey = sqlite.prepare('INSERT OR REPLACE INTO cache (key, data, updatedAt, expiresAt) VALUES (?, ?, ?, ?)');
  cacheKey.run('src-1_streams_vod', '[]', 'x', now + 1000);
  cacheKey.run('src-1_streams_live', '[]', 'x', now + 1000);
  cacheKey.run('src-1_categories', '{}', 'x', now + 1000);

  const metaKey = sqlite.prepare('INSERT OR REPLACE INTO source_sync_meta (key, lastSync, extra) VALUES (?, ?, ?)');
  metaKey.run('snapshot_src-1_vod', 'x', '{}');
  metaKey.run('snapshot_src-1_live', 'x', '{}');
  metaKey.run('snapshot_src-1_categories', 'x', '{}');
  metaKey.run('src-1_live', 'x', '{}'); // sync cooldown, must survive
}

const keysOf = (table: string): string[] =>
  (getSqlite().prepare(`SELECT key FROM ${table} ORDER BY key`).all() as { key: string }[]).map((r) => r.key);

beforeAll(async () => {
  await connectDb();
  seedLegacyRows();
  // Second connect simulates a restart on a database written by the old version.
  await connectDb();
});

afterAll(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(`${dbPath}${suffix}`); } catch { /* not present */ }
  }
});

describe('db — ADR 0002 upgrade cleanup', () => {
  it('removes the obsolete stream blobs', () => {
    expect(keysOf('cache')).toEqual(['src-1_categories']);
  });

  it('removes the obsolete stream snapshots but keeps the category one', () => {
    expect(keysOf('source_sync_meta')).toEqual(['snapshot_src-1_categories', 'src-1_live']);
  });

  it('creates the normalised catalog tables', () => {
    const names = (getSqlite()
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'trigger') ORDER BY name")
      .all() as { name: string }[]).map((r) => r.name);

    expect(names).toContain('streams');
    expect(names).toContain('streams_fts');
  });

  it('is idempotent across repeated startups', async () => {
    await connectDb();
    expect(keysOf('cache')).toEqual(['src-1_categories']);
    expect(keysOf('source_sync_meta')).toEqual(['snapshot_src-1_categories', 'src-1_live']);
  });
});
