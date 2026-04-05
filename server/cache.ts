import { getDb } from './db.ts';
import { cache } from './schema.ts';
import { eq, gt } from 'drizzle-orm';

const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const IN_MEMORY_TTL_MS = 60 * 1000; // 1 minute

interface CacheEntry {
  data: any;
  lastUpdated: string;
  expiresAt: number;
}

const memoryCache = new Map<string, CacheEntry>();

export function getCached(key: string): { data: any; lastUpdated: string } | null {
  // Check memory cache first
  const mem = memoryCache.get(key);
  if (mem && Date.now() < mem.expiresAt) {
    return { data: mem.data, lastUpdated: mem.lastUpdated };
  }

  const db = getDb();
  
  try {
    const row = db.select({ data: cache.data, updatedAt: cache.updatedAt })
      .from(cache)
      .where(
        eq(cache.key, key)
      )
      .get();

    if (!row) return null;

    // Check expiration using simple queries, or we can just fetch and then check TTL
    const dbRow = db.select().from(cache).where(eq(cache.key, key)).get();
    if (!dbRow || !dbRow.expiresAt || Date.now() > dbRow.expiresAt) {
        if (dbRow) {
            db.delete(cache).where(eq(cache.key, key)).run();
        }
        memoryCache.delete(key);
        return null;
    }

    const data = typeof dbRow.data === 'string' ? JSON.parse(dbRow.data) : dbRow.data;
    const lastUpdated = dbRow.updatedAt as string;

    // Update memory cache
    memoryCache.set(key, {
      data,
      lastUpdated,
      expiresAt: Date.now() + IN_MEMORY_TTL_MS
    });

    return { data, lastUpdated };
  } catch (error) {
    console.error('Cache get error:', error);
    return null;
  }
}

export function setCache(key: string, data: any): void {
  const db = getDb();
  const lastUpdated = new Date().toISOString();
  const expiresAt = Date.now() + CACHE_TTL_MS;

  try {
    const dataStr = JSON.stringify(data);
    db.insert(cache)
      .values({
        key,
        data: dataStr,
        updatedAt: lastUpdated,
        expiresAt
      })
      .onConflictDoUpdate({
        target: cache.key,
        set: {
          data: dataStr,
          updatedAt: lastUpdated,
          expiresAt
        }
      })
      .run();

    // Update memory cache
    memoryCache.set(key, {
      data,
      lastUpdated,
      expiresAt: Date.now() + IN_MEMORY_TTL_MS
    });
  } catch (error) {
    console.error('Cache set error:', error);
  }
}

export function clearCache(key?: string): void {
  const db = getDb();
  try {
    if (key) {
      db.delete(cache).where(eq(cache.key, key)).run();
      memoryCache.delete(key);
    } else {
      db.delete(cache).run();
      memoryCache.clear();
    }
  } catch (error) {
    console.error('Cache clear error:', error);
  }
}

export function duplicateCache(oldKey: string, newKey: string): void {
  const db = getDb();
  try {
    const oldRow = db.select().from(cache).where(eq(cache.key, oldKey)).get();
    if (oldRow) {
      db.insert(cache)
        .values({
          key: newKey,
          data: oldRow.data,
          updatedAt: oldRow.updatedAt,
          expiresAt: oldRow.expiresAt
        })
        .onConflictDoUpdate({
          target: cache.key,
          set: {
            data: oldRow.data,
            updatedAt: oldRow.updatedAt,
            expiresAt: oldRow.expiresAt
          }
        })
        .run();

      // If old key is in memory, copy it to new key in memory too
      const mem = memoryCache.get(oldKey);
      if (mem) {
        memoryCache.set(newKey, { ...mem });
      }
    }
  } catch (error) {
    console.error('Cache duplicate error:', error);
  }
}
