import { connectDb } from './db.ts';
import { log } from './logger.ts';
import { refreshSource, initCronManager, rescheduleCrons } from './sync.ts';

/**
 * Sync worker — the process that owns every catalog sync.
 *
 * A sync performs seconds of synchronous SQLite work: writing a 184 k-row
 * partition measured 3.25 s on the production box, and the FTS rebuild that used
 * to accompany it up to 10.8 s. On the API process's event loop that competes with
 * the live-stream multiplexer for the same thread, so a large sync could stall
 * playback (observed: 36 s, well past the jitter buffer).
 *
 * Here it cannot. This process has its own event loop and heap, so no sync - no
 * matter how large, slow, or broken - occupies the thread the streams run on. The
 * API process only exchanges small messages with it, and a crash here (an OOM, for
 * instance) kills the sync, not the streams.
 *
 * It also owns the cron schedule, because every job it fires is a sync.
 */

type SyncRequest = { id: number; op: 'sync'; sourceId: string; type: 'live' | 'vod' | 'series'; force: boolean };
type RescheduleRequest = { id: number; op: 'reschedule' };
type WorkerRequest = SyncRequest | RescheduleRequest;

function reply(message: Record<string, unknown>): void {
  process.send?.(message);
}

async function handle(request: WorkerRequest): Promise<void> {
  if (request.op === 'reschedule') {
    await rescheduleCrons();
    reply({ id: request.id, ok: true, result: null });
    return;
  }

  const result = await refreshSource(request.sourceId, request.type, request.force);
  reply({ id: request.id, ok: true, result });
  // Tell the API process to drop its in-memory catalog mirror for this partition.
  reply({ op: 'synced', sourceId: request.sourceId, type: request.type });
}

async function main(): Promise<void> {
  await connectDb();
  log(`[SyncWorker] started (pid ${process.pid})`);
  await initCronManager();

  process.on('message', (message: WorkerRequest) => {
    void handle(message).catch((err: unknown) => {
      reply({ id: message.id, ok: false, error: err instanceof Error ? err.message : String(err) });
    });
  });

  // The parent went away; nothing to sync for.
  process.on('disconnect', () => process.exit(0));
}

main().catch((err: unknown) => {
  log(`[SyncWorker] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
