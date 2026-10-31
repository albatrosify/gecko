import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Proves the property ADR 0004 exists for: a catalog sync cannot block the process
 * that serves streams.
 *
 * It seeds a source pointing at a mock upstream that returns a large catalog, then
 * runs a real sync through the worker while a 20 ms timer measures the longest gap
 * in THIS process's event loop. If the sync were running here, that gap would be
 * the size of the write (hundreds of ms to seconds); because it runs in the
 * worker, the gap must stay at scheduling-noise level.
 *
 * Run under both runtimes:
 *   npx tsx scripts/check-sync-isolation.ts
 *   bun scripts/check-sync-isolation.ts
 */

/** Longest tolerated loop gap in the serving process, in ms. */
const MAX_LOOP_GAP_MS = 250;
const CATALOG_SIZE = 120_000;

const dbPath = path.join(os.tmpdir(), `gecko-isolation-${process.pid}-${Date.now()}.db`);
process.env.SQLITE_PATH = dbPath;

const runtime = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined' ? 'bun' : 'node';

// --- mock upstream returning a catalog big enough to be slow to write --------
const catalog = Array.from({ length: CATALOG_SIZE }, (_, i) => ({
  stream_id: String(i),
  name: `Mock Channel ${i} Sports HD`,
  category_id: String(i % 50),
  stream_icon: `http://i/${i}.png`,
  container_extension: 'mp4',
}));

const upstream = http.createServer((req, res) => {
  const action = new URL(req.url ?? '/', 'http://x').searchParams.get('action');
  res.setHeader('content-type', 'application/json');
  if (action === 'get_vod_streams') return res.end(JSON.stringify(catalog));
  if (action?.endsWith('_categories')) return res.end(JSON.stringify([{ category_id: '1', category_name: 'Cat' }]));
  if (action === 'get_live_streams' || action === 'get_series') return res.end(JSON.stringify([]));
  return res.end(JSON.stringify({
    user_info: { auth: 1, status: 'Active', username: 'u', password: 'p', exp_date: null, max_connections: '1' },
    server_info: { url: '127.0.0.1', port: '1', https_port: '1', server_protocol: 'http' },
  }));
});
await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
const upstreamPort = (upstream.address() as { port: number }).port;

const { connectDb, getDb, generateId } = await import('../server/db.ts');
const { sources } = await import('../server/schema.ts');
const { startSyncWorker, requestSourceSync, stopSyncWorker } = await import('../server/sync-client.ts');
const { countSourceStreams } = await import('../server/stream-store.ts');

await connectDb();
const sourceId = generateId();
getDb().insert(sources).values({
  id: sourceId, userId: 'u1', name: 'Mock', type: 'xtream',
  url: `http://127.0.0.1:${upstreamPort}`, username: 'u', password: 'p',
  autoSyncEnabled: false, syncCron: null,
}).run();

startSyncWorker();

let lastTick = Date.now();
let maxGapMs = 0;
let ticks = 0;
const timer = setInterval(() => {
  const now = Date.now();
  maxGapMs = Math.max(maxGapMs, now - lastTick);
  lastTick = now;
  ticks++;
}, 20);

const startedAt = Date.now();
await requestSourceSync(sourceId, 'vod', true);
const elapsedMs = Date.now() - startedAt;
clearInterval(timer);

const rows = countSourceStreams(sourceId, 'vod');
stopSyncWorker();
upstream.close();

for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(`${dbPath}${suffix}`); } catch { /* not present */ }
}

console.log(`[${runtime}] sync wall time     : ${(elapsedMs / 1000).toFixed(2)} s`);
console.log(`[${runtime}] rows written       : ${rows}`);
console.log(`[${runtime}] serving-loop ticks : ${ticks}`);
console.log(`[${runtime}] longest loop gap   : ${maxGapMs} ms  (limit ${MAX_LOOP_GAP_MS} ms)`);

const failures: string[] = [];
if (rows !== CATALOG_SIZE) failures.push(`expected ${CATALOG_SIZE} rows, got ${rows}`);
if (maxGapMs > MAX_LOOP_GAP_MS) failures.push(`serving process was blocked for ${maxGapMs} ms`);

if (failures.length > 0) {
  console.error(`\n[${runtime}] FAILED:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log(`\n[${runtime}] PASS - the sync did not block the serving process.`);
