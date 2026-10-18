import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { log } from './logger.ts';
import { invalidateSourceStreams } from './stream-store.ts';
import type { StreamType } from './stream-store.ts';

/**
 * Client side of the sync worker (see `server/sync-worker.ts`).
 *
 * The API/streaming process never runs a sync itself; it asks the worker over IPC.
 * That is what makes it impossible for a sync to stall a stream: the work is not
 * on this thread at all, so its size stops mattering.
 *
 * The worker is restarted automatically if it dies, so a crash (or an OOM) costs
 * at most the sync in flight.
 */

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const WORKER_PATH = fileURLToPath(new URL('./sync-worker.ts', import.meta.url));
const REQUEST_TIMEOUT_MS = 30 * 60 * 1000;
const RESTART_DELAY_MS = 5_000;

let worker: ChildProcess | null = null;
let nextRequestId = 1;
const pending = new Map<number, Pending>();

function settleAll(error: Error): void {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(error);
  }
  pending.clear();
}

function handleMessage(message: {
  op?: string;
  id?: number;
  ok?: boolean;
  result?: unknown;
  error?: string;
  sourceId?: string;
  type?: string;
}): void {
  if (message?.op === 'synced') {
    // A new catalog landed; drop the mirror so the next read picks it up.
    invalidateSourceStreams(message.sourceId, message.type as StreamType);
    return;
  }

  const entry = message?.id === undefined ? undefined : pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id!);
  clearTimeout(entry.timer);
  if (message.ok) entry.resolve(message.result);
  else entry.reject(new Error(message.error || 'sync failed'));
}

function spawnWorker(): void {
  const child = fork(WORKER_PATH, [], {
    // Tag the worker's log lines so they are distinguishable from the API process's.
    env: { ...process.env, GECKO_PROCESS_ROLE: 'sync-worker' },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  worker = child;

  child.on('message', handleMessage);
  child.on('exit', (code, signal) => {
    if (worker !== child) return; // superseded by a newer worker
    worker = null;
    settleAll(new Error('sync worker exited'));
    log(`[SyncWorker] exited (code=${code} signal=${signal}); restarting in ${RESTART_DELAY_MS / 1000}s`);
    setTimeout(spawnWorker, RESTART_DELAY_MS).unref?.();
  });

  log(`[SyncWorker] spawned (pid ${child.pid})`);
}

/** Starts the worker if it is not already running. */
export function startSyncWorker(): void {
  if (!worker) spawnWorker();
}

/** Stops the worker (used on shutdown). */
export function stopSyncWorker(): void {
  const child = worker;
  worker = null;
  child?.kill();
}

function send(message: Record<string, unknown>): Promise<unknown> {
  const child = worker;
  if (!child || !child.connected) return Promise.reject(new Error('sync worker is not running'));

  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('sync request timed out'));
    }, REQUEST_TIMEOUT_MS);
    timer.unref?.();
    pending.set(id, { resolve, reject, timer });
    child.send({ ...message, id });
  });
}

/** Runs a catalog sync in the worker process. */
export function requestSourceSync(
  sourceId: string,
  type: 'live' | 'vod' | 'series',
  force = false,
): Promise<unknown> {
  return send({ op: 'sync', sourceId, type, force });
}

/** Asks the worker to rebuild its cron schedule after a source changed. */
export function notifyCronsChanged(): void {
  if (!worker?.connected) return;
  worker.send({ op: 'reschedule', id: 0 });
}
