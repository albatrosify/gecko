import { getDb, generateId } from './db.ts';
import { sources, source_connection_logs } from './schema.ts';
import { XtreamClient } from './xtream.ts';
import { proxyStats } from './proxy-stats.ts';
import { log } from './logger.ts';
import { parseXtreamExpDate } from './utils.ts';
import { eq, desc, inArray } from 'drizzle-orm';
import { UpstreamSource, SourceConnectionLog } from '../src/types.ts';

let monitorIntervalTimer: NodeJS.Timeout | null = null;
const isCheckingMap = new Map<string, boolean>();

/**
 * Checks an upstream Xtream source's connection status, compares with Gecko proxy connections,
 * and records a history log in the database.
 */
export async function checkSourceConnection(
  source: UpstreamSource,
  isManual: boolean = false
): Promise<SourceConnectionLog> {
  const sourceId = source.id;
  const now = new Date().toISOString();
  const db = getDb();

  // Prevent overlapping checks for the same source
  if (isCheckingMap.get(sourceId)) {
    throw new Error('A connection check is already in progress for this source.');
  }

  isCheckingMap.set(sourceId, true);

  try {
    if (source.type !== 'xtream' || !source.url || !source.username || !source.password) {
      throw new Error('Connection monitoring is only supported for Xtream Codes sources with valid credentials.');
    }

    const client = new XtreamClient(source as any);
    let activeCons = 0;
    let maxCons = 1;
    let status: 'ok' | 'external_activity' | 'error' = 'ok';
    let details = '';
    let errorMessage: string | undefined;
    let auth: any;

    try {
      auth = await client.authenticate();
    } catch (err: any) {
      errorMessage = err.message || 'Authentication request failed';
      status = 'error';
      details = `Upstream error: ${errorMessage}`;
    }

    if (auth && auth.user_info) {
      const parsedActive = parseInt(auth.user_info.active_cons ?? '0', 10);
      const parsedMax = parseInt(auth.user_info.max_connections ?? '1', 10);
      activeCons = isNaN(parsedActive) ? 0 : parsedActive;
      maxCons = isNaN(parsedMax) ? 1 : parsedMax;

      // Count active streams currently handled by Gecko proxy for this source
      const geckoStreams = Array.from(proxyStats.connections.values()).filter(
        c => c.sourceId === sourceId
      ).length;

      const isExternal = activeCons > geckoStreams;

      if (isExternal) {
        status = 'external_activity';
        const extCount = activeCons - geckoStreams;
        details = `${extCount} external stream connection(s) detected outside Gecko (${activeCons} total, ${geckoStreams} via Gecko)`;
      } else if (activeCons > 0) {
        status = 'ok';
        details = `${geckoStreams} stream connection(s) active via Gecko (${activeCons}/${maxCons})`;
      } else {
        status = 'ok';
        details = `Idle: 0 active connections (${maxCons} max)`;
      }

      const logId = generateId();
      const logEntry: SourceConnectionLog = {
        id: logId,
        sourceId,
        timestamp: now,
        activeCons,
        maxCons,
        geckoStreams,
        status,
        isExternal,
        details,
        extra: {
          accountStatus: auth.user_info.status,
          isManual
        }
      };

      // Save log to SQLite
      db.insert(source_connection_logs).values({
        id: logId,
        sourceId,
        timestamp: now,
        activeCons,
        maxCons,
        geckoStreams,
        status,
        isExternal: isExternal,
        details,
        extra: logEntry.extra
      }).run();

      // Update source metadata with last checked values
      const sourceDoc = db.select().from(sources).where(eq(sources.id, sourceId)).get();
      if (sourceDoc) {
        const mergedExtra = {
          ...(sourceDoc.extra as any || {}),
          lastMonitorCheck: now,
          lastActiveCons: activeCons,
          lastMaxCons: maxCons,
          lastMonitorStatus: status,
          lastMonitorError: null,
        };

        if (auth.user_info.exp_date) {
          mergedExtra.expiryDate = parseXtreamExpDate(auth.user_info.exp_date);
        }
        if (auth.user_info.status) {
          mergedExtra.accountStatus = auth.user_info.status;
        }
        if (auth.user_info.max_connections !== undefined) {
          mergedExtra.maxConnections = maxCons;
        }

        db.update(sources).set({ extra: mergedExtra }).where(eq(sources.id, sourceId)).run();
      }

      // Cleanup old logs (keep up to 500 latest entries per source)
      pruneConnectionLogs(sourceId, 500);

      log(`[Monitor] Source "${source.name}": ${details} (${isManual ? 'manual' : 'auto'})`);
      return logEntry;
    } else if (status === 'error') {
      const geckoStreams = Array.from(proxyStats.connections.values()).filter(
        c => c.sourceId === sourceId
      ).length;

      const logId = generateId();
      const logEntry: SourceConnectionLog = {
        id: logId,
        sourceId,
        timestamp: now,
        activeCons: 0,
        maxCons: 1,
        geckoStreams,
        status: 'error',
        isExternal: false,
        details: details || 'Failed to authenticate with upstream',
        extra: { error: errorMessage, isManual }
      };

      db.insert(source_connection_logs).values({
        id: logId,
        sourceId,
        timestamp: now,
        activeCons: 0,
        maxCons: 1,
        geckoStreams,
        status: 'error',
        isExternal: false,
        details: logEntry.details,
        extra: logEntry.extra
      }).run();

      const sourceDoc = db.select().from(sources).where(eq(sources.id, sourceId)).get();
      if (sourceDoc) {
        const mergedExtra = {
          ...(sourceDoc.extra as any || {}),
          lastMonitorCheck: now,
          lastMonitorStatus: 'error',
          lastMonitorError: errorMessage,
        };
        db.update(sources).set({ extra: mergedExtra }).where(eq(sources.id, sourceId)).run();
      }

      return logEntry;
    }

    throw new Error('Unexpected response format from upstream server.');
  } finally {
    isCheckingMap.delete(sourceId);
  }
}

/**
 * Prunes historical connection logs to keep table size optimized.
 */
function pruneConnectionLogs(sourceId: string, keepCount: number = 500): void {
  try {
    const db = getDb();
    const allLogs = db.select({ id: source_connection_logs.id })
      .from(source_connection_logs)
      .where(eq(source_connection_logs.sourceId, sourceId))
      .orderBy(desc(source_connection_logs.timestamp))
      .all();

    if (allLogs.length > keepCount) {
      const toDelete = allLogs.slice(keepCount).map(l => l.id);
      db.delete(source_connection_logs).where(inArray(source_connection_logs.id, toDelete)).run();
    }
  } catch (err: any) {
    log(`[Monitor] Failed to prune logs for ${sourceId}: ${err.message}`);
  }
}

/**
 * Retrieves connection history logs for an upstream source.
 */
export function getConnectionLogs(sourceId: string, limit: number = 100): SourceConnectionLog[] {
  const db = getDb();
  const rows = db.select()
    .from(source_connection_logs)
    .where(eq(source_connection_logs.sourceId, sourceId))
    .orderBy(desc(source_connection_logs.timestamp))
    .limit(limit)
    .all();

  return rows.map(r => ({
    id: r.id,
    sourceId: r.sourceId,
    timestamp: r.timestamp,
    activeCons: r.activeCons,
    maxCons: r.maxCons,
    geckoStreams: r.geckoStreams,
    status: r.status as any,
    isExternal: Boolean(r.isExternal),
    details: r.details || undefined,
    extra: r.extra
  }));
}

/**
 * Clears all connection history logs for a source.
 */
export function clearConnectionLogs(sourceId: string): void {
  const db = getDb();
  db.delete(source_connection_logs).where(eq(source_connection_logs.sourceId, sourceId)).run();
}

/**
 * Runs one check cycle across all sources with monitoring enabled.
 */
async function runMonitorCycle(): Promise<void> {
  try {
    const db = getDb();
    const allSources = db.select().from(sources).all();

    for (const rawSource of allSources) {
      const extra = (rawSource.extra as any) || {};
      const source: UpstreamSource = {
        id: rawSource.id,
        name: rawSource.name,
        type: rawSource.type as any,
        url: rawSource.url,
        username: rawSource.username || undefined,
        password: rawSource.password || undefined,
        enabled: extra.enabled !== false,
        autoSyncEnabled: Boolean(rawSource.autoSyncEnabled),
        syncCron: rawSource.syncCron || undefined,
        ...extra
      };

      if (source.type !== 'xtream' || !source.monitorEnabled) {
        continue;
      }

      const intervalSec = source.monitorInterval && source.monitorInterval >= 15 ? source.monitorInterval : 60;
      const lastCheckTime = source.lastMonitorCheck ? new Date(source.lastMonitorCheck).getTime() : 0;
      const elapsedSec = (Date.now() - lastCheckTime) / 1000;

      if (elapsedSec >= intervalSec) {
        // Run check asynchronously so one source's delay does not block others
        checkSourceConnection(source, false).catch(err => {
          log(`[Monitor] Auto-check failed for ${source.name}: ${err.message}`);
        });
      }
    }
  } catch (err: any) {
    log(`[Monitor] Error during monitor cycle: ${err.message}`);
  }
}

/**
 * Initializes the connection monitor background loop.
 */
export function initConnectionMonitor(): void {
  if (monitorIntervalTimer) {
    clearInterval(monitorIntervalTimer);
  }

  log('Initializing Upstream Connection Monitor...');
  // Tick every 15 seconds to check if any source's interval has expired
  monitorIntervalTimer = setInterval(runMonitorCycle, 15000);
}
