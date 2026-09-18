import fs from 'fs';
import { getDb } from './db.ts';
import { cache } from './schema.ts';
import { eq, count, sum } from 'drizzle-orm';


const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

/**
 * When CACHE_BACKEND=memory the SQLite table is bypassed entirely and all
 * entries are kept in the process heap for their full TTL.  This is useful
 * when you want faster reads and don't need the cache to survive a restart.
 *
 * When CACHE_BACKEND=sqlite (default) a short-lived in-process mirror still
 * sits in front of the DB so repeated hot reads never touch disk.
 */
const USE_MEMORY_BACKEND = process.env.CACHE_BACKEND === 'memory';
const IN_MEMORY_TTL_MS = USE_MEMORY_BACKEND
  ? CACHE_TTL_MS          // full TTL — memory IS the store
  : 60 * 1000;            // 1 minute — just a hot-read mirror in front of SQLite

interface CacheEntry {
  data: any;
  lastUpdated: string;
  expiresAt: number;
}

const memoryCache = new Map<string, CacheEntry>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the cached value for `key`, or `null` if it is absent / expired.
 */
export function getCached(key: string): { data: any; lastUpdated: string } | null {
  // Always check the in-process map first.
  const mem = memoryCache.get(key);
  if (mem && Date.now() < mem.expiresAt) {
    return { data: mem.data, lastUpdated: mem.lastUpdated };
  }

  if (USE_MEMORY_BACKEND) {
    // Entry was missing or expired — clean up and bail.
    memoryCache.delete(key);
    return null;
  }

  // --- SQLite path ---
  const db = getDb();
  try {
    const dbRow = db.select().from(cache).where(eq(cache.key, key)).get();

    if (!dbRow) return null;

    if (!dbRow.expiresAt || Date.now() > dbRow.expiresAt) {
      db.delete(cache).where(eq(cache.key, key)).run();
      memoryCache.delete(key);
      return null;
    }

    const data = typeof dbRow.data === 'string' ? JSON.parse(dbRow.data) : dbRow.data;
    const lastUpdated = dbRow.updatedAt as string;

    // Populate the short-lived in-process mirror.
    memoryCache.set(key, { data, lastUpdated, expiresAt: Date.now() + IN_MEMORY_TTL_MS });

    return { data, lastUpdated };
  } catch (error) {
    console.error('Cache get error:', error);
    return null;
  }
}

/**
 * Stores `data` under `key`.  Overwrites any existing entry.
 */
export function setCache(key: string, data: any): void {
  const lastUpdated = new Date().toISOString();
  const expiresAt = Date.now() + CACHE_TTL_MS;

  // Always write to the in-process map.
  memoryCache.set(key, {
    data,
    lastUpdated,
    expiresAt: Date.now() + IN_MEMORY_TTL_MS,
  });

  if (USE_MEMORY_BACKEND) return;

  // --- SQLite path ---
  const db = getDb();
  try {
    db.insert(cache)
      .values({ key, data, updatedAt: lastUpdated, expiresAt })
      .onConflictDoUpdate({
        target: cache.key,
        set: { data, updatedAt: lastUpdated, expiresAt },
      })
      .run();
  } catch (error) {
    console.error('Cache set error:', error);
  }
}

/**
 * Removes a specific `key` from the cache, or clears the entire cache when
 * called without arguments.
 */
export function clearCache(key?: string): void {
  if (key) {
    memoryCache.delete(key);
  } else {
    memoryCache.clear();
  }

  if (USE_MEMORY_BACKEND) return;

  // --- SQLite path ---
  const db = getDb();
  try {
    if (key) {
      db.delete(cache).where(eq(cache.key, key)).run();
    } else {
      db.delete(cache).run();
    }
  } catch (error) {
    console.error('Cache clear error:', error);
  }
}

/**
 * Copies the cached entry at `oldKey` to `newKey`, preserving the original
 * TTL.
 */
export function duplicateCache(oldKey: string, newKey: string): void {
  // Try the in-process map first (always populated in memory-backend mode).
  const mem = memoryCache.get(oldKey);
  if (mem) {
    memoryCache.set(newKey, { ...mem });
    if (USE_MEMORY_BACKEND) return;
  }

  if (USE_MEMORY_BACKEND) return;

  // --- SQLite path ---
  const db = getDb();
  try {
    const oldRow = db.select().from(cache).where(eq(cache.key, oldKey)).get();
    if (oldRow) {
      db.insert(cache)
        .values({
          key: newKey,
          data: oldRow.data,
          updatedAt: oldRow.updatedAt,
          expiresAt: oldRow.expiresAt,
        })
        .onConflictDoUpdate({
          target: cache.key,
          set: {
            data: oldRow.data,
            updatedAt: oldRow.updatedAt,
            expiresAt: oldRow.expiresAt,
          },
        })
        .run();

      // Keep in-process map in sync if the entry wasn't already there.
      if (!mem && oldRow.expiresAt && Date.now() < oldRow.expiresAt) {
        const data =
          typeof oldRow.data === 'string' ? JSON.parse(oldRow.data) : oldRow.data;
        memoryCache.set(newKey, {
          data,
          lastUpdated: oldRow.updatedAt as string,
          expiresAt: Date.now() + IN_MEMORY_TTL_MS,
        });
      }
    }
  } catch (error) {
    console.error('Cache duplicate error:', error);
  }
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export interface CacheStats {
  /** Which backend is active: 'memory' or 'sqlite'. */
  backend: 'memory' | 'sqlite';
  /** Number of non-expired entries currently held. */
  entries: number;
  /**
   * Approximate size in bytes.
   * - memory  → JSON-serialised size of every live entry's data field.
   * - sqlite  → Physical size of the SQLite DB file on disk.
   */
  bytes: number;
  /** Human-readable size string, e.g. "1.23 MB". */
  size: string;
  /** Cache TTL in milliseconds. */
  ttlMs: number;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Returns size/count statistics for the cache.
 * Designed to be cheap — no heavy scans are performed.
 */
export function getCacheStats(): CacheStats {
  const now = Date.now();

  if (USE_MEMORY_BACKEND) {
    let entries = 0;
    let bytes = 0;
    for (const [, entry] of memoryCache) {
      if (now < entry.expiresAt) {
        entries++;
        try {
          bytes += JSON.stringify(entry.data).length;
        } catch {
          // non-serialisable value — skip size contribution
        }
      }
    }
    return { backend: 'memory', entries, bytes, size: formatBytes(bytes), ttlMs: CACHE_TTL_MS };
  }

  // SQLite backend: report the physical DB file size and live row count.
  let bytes = 0;
  let entries = 0;
  try {
    const dbPath = process.env.SQLITE_PATH || './gecko.db';
    const stat = fs.statSync(dbPath);
    bytes = stat.size;
  } catch {
    // file not accessible — leave at 0
  }
  try {
    const db = getDb();
    entries =
      db
        .select({ value: count() })
        .from(cache)
        .get()?.value ?? 0;
  } catch {
    // DB not ready
  }
  return { backend: 'sqlite', entries, bytes, size: formatBytes(bytes), ttlMs: CACHE_TTL_MS };
}
