import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Data-layer benchmark (ADR 0002).
 *
 * Runs the catalog write/read paths against a throwaway SQLite file so it can be
 * run anywhere — including on a production box — without touching a real
 * database. Defaults to a synthetic catalog so results are comparable between
 * machines; pass `--source=<db>` to use the real one instead.
 *
 *   npx tsx scripts/bench-data-layer.ts
 *   npx tsx scripts/bench-data-layer.ts --items=185000
 *   npx tsx scripts/bench-data-layer.ts --source=/app/data/gecko.db
 *
 * The column that matters for the stall being chased is "bytes written": a sync
 * that changed nothing must write 0. It is measured from the WAL, because file
 * size only grows when the database needs new pages — changed rows often reuse
 * freed ones and would otherwise read as 0.
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, '').split('=');
    return [key, value ?? 'true'];
  }),
);

const itemCount = Number(args.items ?? 50_000);
const sourcePath = typeof args.source === 'string' ? args.source : null;

// Must be set before the modules are imported, because they read it at import time.
const dbPath = path.join(os.tmpdir(), `gecko-bench-${process.pid}-${Date.now()}.db`);
const walPath = `${dbPath}-wal`;
process.env.SQLITE_PATH = dbPath;

const { connectDb, getSqlite } = await import('../server/db.ts');
const { replaceSourceStreamsWithDiff, readSourceStreams, searchStreams, invalidateSourceStreams } =
  await import('../server/stream-store.ts');
const BetterSqlite3 = (await import('better-sqlite3')).default;

/** Builds a synthetic catalog with a realistic field mix. */
function syntheticCatalog(count: number): Record<string, unknown>[] {
  const genres = ['Sports', 'Movies', 'News', 'Kids', 'Docs', 'Music'];
  const items: Record<string, unknown>[] = [];
  for (let i = 0; i < count; i++) {
    items.push({
      stream_id: String(i + 1),
      name: `Channel ${i} ${genres[i % genres.length]} HD`,
      category_id: i % 500,
      stream_icon: `http://img.example.com/${i}.png`,
      container_extension: 'mp4',
      rating: String((i % 100) / 10),
      added: '1700000000',
    });
  }
  return items;
}

/** Reads the real catalog out of an existing install's cache blobs. */
function catalogFromDb(file: string): Record<string, unknown>[] {
  const db = new BetterSqlite3(file, { readonly: true });
  const row = db.prepare('select data from cache where key like ?').get('%_streams_vod') as { data: string } | undefined;
  db.close();
  if (!row) throw new Error(`No VOD catalog found in ${file}`);
  return JSON.parse(row.data) as Record<string, unknown>[];
}

const items = sourcePath ? catalogFromDb(sourcePath) : syntheticCatalog(itemCount);

await connectDb();
const sqlite = getSqlite();

const checkpoint = (): void => {
  // `exec` rather than `pragma()`: bun:sqlite has no `pragma()` method.
  sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)');
};

/** Runs an operation on a clean WAL and reports elapsed time + bytes written. */
function measureWrite(label: string, fn: () => unknown): void {
  checkpoint();
  const start = performance.now();
  fn();
  const ms = performance.now() - start;
  const bytes = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
  checkpoint();
  console.log(label.padEnd(34), ms.toFixed(0).padStart(7), 'ms', String(bytes).padStart(11), 'bytes written');
}

function measureOnce(label: string, fn: () => unknown): void {
  const start = performance.now();
  fn();
  console.log(label.padEnd(34), (performance.now() - start).toFixed(0).padStart(7), 'ms');
}

function measureMedian(label: string, fn: () => unknown, iterations = 20): void {
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  console.log(
    label.padEnd(34),
    samples[Math.floor(samples.length / 2)].toFixed(3).padStart(8),
    'ms  (median of ' + iterations + ')',
  );
}

console.log(`\ncatalog: ${items.length} items${sourcePath ? ` (from ${sourcePath})` : ' (synthetic)'}`);
console.log(`db     : ${dbPath}\n`);

// --- write path -----------------------------------------------------------
measureWrite('initial load (all new)', () => replaceSourceStreamsWithDiff('bench', 'vod', items));
measureWrite('re-sync, no changes', () => replaceSourceStreamsWithDiff('bench', 'vod', items));

const mutated = items.slice();
mutated[Math.floor(mutated.length / 2)] = { ...mutated[0], name: 'Renamed Channel' };
mutated.pop();
mutated.push({ stream_id: 'new-1', name: 'Brand New Channel' });
measureWrite('re-sync, small delta (3 rows)', () => replaceSourceStreamsWithDiff('bench', 'vod', mutated));

// --- read path ------------------------------------------------------------
console.log('');
invalidateSourceStreams('bench', 'vod');
measureOnce('cold read (materialise)', () => readSourceStreams('bench', 'vod'));
measureMedian('warm read (mirror)', () => readSourceStreams('bench', 'vod'));

// --- search ---------------------------------------------------------------
console.log('');
measureMedian('search, >=3 chars (FTS5 MATCH)', () => searchStreams('Sports', { limit: 50 }));
measureMedian('search, 2 chars (scan fallback)', () => searchStreams('HD', { limit: 50 }));

checkpoint();
console.log(`\nfinal db size: ${(fs.statSync(dbPath).size / 1048576).toFixed(2)} MB`);

for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(`${dbPath}${suffix}`); } catch { /* not present */ }
}
