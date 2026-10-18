import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Runtime parity check for the SQLite driver.
 *
 * `server/db.ts` selects `bun:sqlite` under Bun and `better-sqlite3` under Node,
 * and the two disagree in places — most notably `.get()`: better-sqlite3 returns
 * `undefined` for "no row", bun:sqlite returns `null`. Code that tests the result
 * against `undefined` therefore silently inverts under Bun.
 *
 * That class of bug is invisible to the vitest suite, because vitest runs on
 * Node. This script must be executed under BOTH runtimes:
 *
 *   node --import tsx scripts/check-db-driver.ts
 *   bun scripts/check-db-driver.ts
 *
 * Exits non-zero on the first mismatch.
 */

const dbPath = path.join(os.tmpdir(), `gecko-parity-${process.pid}-${Date.now()}.db`);
process.env.SQLITE_PATH = dbPath;

const { connectDb } = await import('../server/db.ts');
const { hasSourceStreams, readSourceStreams, countSourceStreams, searchStreams, replaceSourceStreams, getStreamRow } =
  await import('../server/stream-store.ts');

const runtime = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined' ? 'bun' : 'node';
const results: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean): void => {
  results.push({ name, ok });
};

await connectDb();

// --- empty partition: every accessor must report "nothing" -------------------
check('hasSourceStreams(empty) === false', hasSourceStreams('missing', 'vod') === false);
check('readSourceStreams(empty) === []', readSourceStreams('missing', 'vod').length === 0);
check('countSourceStreams(empty) === 0', countSourceStreams('missing', 'vod') === 0);
check('searchStreams(empty) === []', searchStreams('Alpha', { type: 'vod' }).length === 0);
check('getStreamRow(empty) === null', getStreamRow('missing', 'vod', '1') === null);

// --- populated partition ----------------------------------------------------
const stored = replaceSourceStreams('src-parity', 'vod', [
  { stream_id: '1', name: 'Parity Alpha' },
  { stream_id: '2', name: 'Parity Beta' },
]);
check('replaceSourceStreams returns 2', stored === 2);
check('hasSourceStreams(populated) === true', hasSourceStreams('src-parity', 'vod') === true);
check('countSourceStreams(populated) === 2', countSourceStreams('src-parity', 'vod') === 2);
check('searchStreams finds a substring', searchStreams('Alpha', { type: 'vod' }).length === 1);
check('searchStreams misses an absent term', searchStreams('Zulu', { type: 'vod' }).length === 0);
check('readSourceStreams materialises rows', readSourceStreams('src-parity', 'vod').length === 2);
check('getStreamRow returns a row', getStreamRow('src-parity', 'vod', '1')?.name === 'Parity Alpha');
check('getStreamRow returns null for a miss', getStreamRow('src-parity', 'vod', 'nope') === null);

const failures = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  [${runtime}] ${r.name}`);
console.log(`\n${runtime}: ${results.length - failures.length}/${results.length} passed`);

for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(`${dbPath}${suffix}`); } catch { /* not present */ }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} parity check(s) failed under ${runtime}.`);
  process.exit(1);
}
