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

  it('reclaims free pages on reconnect instead of leaving them in the file', async () => {
    // Deleting data moves pages onto SQLite's freelist but never shrinks the
    // file, which is what made a cleaned-up prod DB stay at ~1 GB. connectDb()
    // should notice and VACUUM.
    const freeRatio = (): number => {
      const sqlite = getSqlite();
      const free = Number((sqlite.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count);
      const total = Number((sqlite.prepare('PRAGMA page_count').get() as { page_count: number }).page_count);
      return total > 0 ? free / total : 0;
    };

    const sqlite = getSqlite();
    sqlite.exec('CREATE TABLE _ballast (id INTEGER PRIMARY KEY, blob TEXT)');
    const insert = sqlite.prepare('INSERT INTO _ballast (blob) VALUES (?)');
    const payload = 'x'.repeat(10_000);
    sqlite.transaction(() => {
      for (let i = 0; i < 2_000; i++) insert.run(payload);
    })();
    sqlite.exec('DELETE FROM _ballast');
    sqlite.exec('DROP TABLE _ballast');

    // Precondition: enough free pages that the VACUUM threshold is crossed.
    expect(freeRatio()).toBeGreaterThan(0.2);

    await connectDb();

    expect(freeRatio()).toBeLessThan(0.2);
  });
});
