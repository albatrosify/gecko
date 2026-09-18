import fs from 'fs';
import path from 'path';
import { getDb } from './db.ts';
import { cache } from './schema.ts';
import { eq, count } from 'drizzle-orm';

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
  ? CACHE_TTL_MS        // full TTL — memory IS the store
  : 60 * 1000;          // 1 minute — just a hot-read mirror in front of SQLite

/** DB path, kept in sync with db.ts so statSync hits the right file. */
const DB_PATH = process.env.SQLITE_PATH ?? path.join(process.cwd(), 'data', 'gecko.db');

interface CacheEntry {
  data: any;
  lastUpdated: string;
  expiresAt: number;
  /** Approximate serialised byte size, tracked incrementally to avoid
   *  re-serialising large payloads on every stats call. */
  sizeBytes: number;
}

const memoryCache = new Map<string, CacheEntry>();

/**
 * Running total of live entry sizes in the memory cache.
 * Updated on every set/delete so getCacheStats() never needs to
 * JSON.stringify anything — critical when entries hold large stream arrays.
 */
let memoryCacheBytes = 0;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Fast approximation of an object's JSON size without blocking the event loop. */
function estimateBytes(data: any): number {
  try {
    return JSON.stringify(data).length;
  } catch {
    return 0;
  }
}

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
    if (mem) {
      memoryCacheBytes -= mem.sizeBytes;
      memoryCache.delete(key);
    }
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

    // Populate the short-lived in-process mirror (size tracking not needed
    // for sqlite mirror entries — the authoritative size is the file on disk).
    memoryCache.set(key, { data, lastUpdated, expiresAt: Date.now() + IN_MEMORY_TTL_MS, sizeBytes: 0 });

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

  // Update the running byte counter before overwriting the map entry.
  const sizeBytes = USE_MEMORY_BACKEND ? estimateBytes(data) : 0;
  const existing = memoryCache.get(key);
  if (existing) memoryCacheBytes -= existing.sizeBytes;
  memoryCacheBytes += sizeBytes;

  memoryCache.set(key, {
    data,
    lastUpdated,
    expiresAt: Date.now() + IN_MEMORY_TTL_MS,
    sizeBytes,
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
    const existing = memoryCache.get(key);
    if (existing) memoryCacheBytes -= existing.sizeBytes;
    memoryCache.delete(key);
  } else {
    memoryCacheBytes = 0;
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
    const copy = { ...mem };
    const existing = memoryCache.get(newKey);
    if (existing) memoryCacheBytes -= existing.sizeBytes;
    memoryCacheBytes += copy.sizeBytes;
    memoryCache.set(newKey, copy);
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
          sizeBytes: 0, // sqlite mirror — authoritative size is the file
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
   * - memory  → sum of JSON-serialised sizes, tracked incrementally.
   * - sqlite  → physical size of the SQLite DB file on disk.
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
 * O(1) for the memory backend (counters are maintained incrementally).
 * For sqlite: one statSync + one COUNT(*) query.
 */
export function getCacheStats(): CacheStats {
  if (USE_MEMORY_BACKEND) {
    // Count only live (non-expired) entries — no serialisation needed.
    const now = Date.now();
    let entries = 0;
    for (const entry of memoryCache.values()) {
      if (now < entry.expiresAt) entries++;
    }
    return {
      backend: 'memory',
      entries,
      bytes: memoryCacheBytes,
      size: formatBytes(memoryCacheBytes),
      ttlMs: CACHE_TTL_MS,
    };
  }

  // SQLite backend: physical DB file size + live row count.
  let bytes = 0;
  let entries = 0;
  try {
    bytes = fs.statSync(DB_PATH).size;
  } catch {
    // file not yet created or not accessible
  }
  try {
    entries = getDb().select({ value: count() }).from(cache).get()?.value ?? 0;
  } catch {
    // DB not ready
  }
  return { backend: 'sqlite', entries, bytes, size: formatBytes(bytes), ttlMs: CACHE_TTL_MS };
}
