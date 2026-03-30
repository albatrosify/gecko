import fs from 'fs';
import path from 'path';

const CACHE_DIR = process.env.CACHE_DIR || path.join(process.cwd(), 'data', 'cache');
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const IN_MEMORY_TTL_MS = 60 * 1000; // 1 minute

interface CacheEntry {
  data: any;
  lastUpdated: string;
  expiresAt: number;
}

const memoryCache = new Map<string, CacheEntry>();

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function getCachePath(key: string): string {
  // Sanitize key for filesystem
  const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(CACHE_DIR, `${safeKey}.json`);
}

export function getCached(key: string): { data: any; lastUpdated: string } | null {
  // Check memory cache first
  const mem = memoryCache.get(key);
  if (mem && Date.now() < mem.expiresAt) {
    return { data: mem.data, lastUpdated: mem.lastUpdated };
  }

  ensureCacheDir();
  const filePath = getCachePath(key);
  
  if (!fs.existsSync(filePath)) return null;
  
  try {
    const stat = fs.statSync(filePath);
    const age = Date.now() - stat.mtimeMs;
    
    if (age > CACHE_TTL_MS) {
      // Cache expired
      fs.unlinkSync(filePath);
      memoryCache.delete(key);
      return null;
    }
    
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    const lastUpdated = stat.mtime.toISOString();

    // Update memory cache
    memoryCache.set(key, {
      data,
      lastUpdated,
      expiresAt: Date.now() + IN_MEMORY_TTL_MS
    });

    return { data, lastUpdated };
  } catch {
    return null;
  }
}

export function setCache(key: string, data: any): void {
  ensureCacheDir();
  const filePath = getCachePath(key);
  const lastUpdated = new Date().toISOString();
  fs.writeFileSync(filePath, JSON.stringify(data));

  // Update memory cache
  memoryCache.set(key, {
    data,
    lastUpdated,
    expiresAt: Date.now() + IN_MEMORY_TTL_MS
  });
}

export function clearCache(key?: string): void {
  ensureCacheDir();
  if (key) {
    const filePath = getCachePath(key);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    memoryCache.delete(key);
  } else {
    memoryCache.clear();
    // Clear all cache
    const files = fs.readdirSync(CACHE_DIR);
    for (const file of files) {
      fs.unlinkSync(path.join(CACHE_DIR, file));
    }
  }
}
export function duplicateCache(oldKey: string, newKey: string): void {
  ensureCacheDir();
  const oldPath = getCachePath(oldKey);
  const newPath = getCachePath(newKey);
  if (fs.existsSync(oldPath)) {
    fs.copyFileSync(oldPath, newPath);

    // If old key is in memory, copy it to new key in memory too
    const mem = memoryCache.get(oldKey);
    if (mem) {
      memoryCache.set(newKey, { ...mem });
    }
  }
}
