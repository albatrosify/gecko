import fs from 'fs';
import path from 'path';
import { getDb } from './db.ts';
import { cache } from './schema.ts';
import { eq, count } from 'drizzle-orm';

const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

/**
 * Short-lived in-process mirror in front of SQLite so repeated hot reads never
 * touch disk. The SQLite `cache` table is the authoritative store.
 */
const MIRROR_TTL_MS = 60 * 1000; // 1 minute

/** DB path, kept in sync with db.ts so statSync hits the right file. */
const DB_PATH = process.env.SQLITE_PATH ?? path.join(process.cwd(), 'data', 'gecko.db');

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
  // Check the in-process mirror first.
  const mem = memoryCache.get(key);
  if (mem && Date.now() < mem.expiresAt) {
    return { data: mem.data, lastUpdated: mem.lastUpdated };
  }

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

    // Populate the short-lived mirror.
    memoryCache.set(key, { data, lastUpdated, expiresAt: Date.now() + MIRROR_TTL_MS });

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

  memoryCache.set(key, { data, lastUpdated, expiresAt: Date.now() + MIRROR_TTL_MS });

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
  // Mirror first.
  const mem = memoryCache.get(oldKey);
  if (mem) {
    memoryCache.set(newKey, { ...mem });
  }

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

      // Keep the mirror in sync if the entry wasn't already there.
      if (!mem && oldRow.expiresAt && Date.now() < oldRow.expiresAt) {
        const data =
          typeof oldRow.data === 'string' ? JSON.parse(oldRow.data) : oldRow.data;
        memoryCache.set(newKey, {
          data,
          lastUpdated: oldRow.updatedAt as string,
          expiresAt: Date.now() + MIRROR_TTL_MS,
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
  /** Number of non-expired entries currently held. */
  entries: number;
  /** Physical size of the SQLite DB file on disk. */
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
 * Returns size/count statistics for the cache: physical DB file size + live
 * row count.
 */
export function getCacheStats(): CacheStats {
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
  return { entries, bytes, size: formatBytes(bytes), ttlMs: CACHE_TTL_MS };
}
