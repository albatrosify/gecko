import Database from 'better-sqlite3';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.ts';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

let sqlite: Database.Database;
let db: BetterSQLite3Database<typeof schema>;

export async function connectDb(): Promise<BetterSQLite3Database<typeof schema>> {
  const dbPath = process.env.SQLITE_PATH || path.join(process.cwd(), 'data', 'gecko.db');
  
  // Ensure directory exists
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  
  db = drizzle(sqlite, { schema });
  
  // Ensure tables and indexes exist (simple auto-migrate for basic setup)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password TEXT NOT NULL, role TEXT NOT NULL, createdAt INTEGER);
    CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, userId TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, url TEXT NOT NULL, username TEXT, password TEXT, autoSyncEnabled INTEGER, syncCron TEXT, extra TEXT);
    CREATE TABLE IF NOT EXISTS epgs (id TEXT PRIMARY KEY, userId TEXT NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL, extra TEXT);
    CREATE TABLE IF NOT EXISTS playlists (id TEXT PRIMARY KEY, userId TEXT NOT NULL, name TEXT NOT NULL, username TEXT NOT NULL UNIQUE, password TEXT NOT NULL, sourceIds TEXT, directStreams INTEGER, extra TEXT);
    CREATE TABLE IF NOT EXISTS mappings (id TEXT PRIMARY KEY, playlistId TEXT NOT NULL, type TEXT NOT NULL, originalId TEXT NOT NULL, extra TEXT);
    CREATE TABLE IF NOT EXISTS categoryMappings (id TEXT PRIMARY KEY, playlistId TEXT NOT NULL, type TEXT NOT NULL, originalId TEXT NOT NULL, extra TEXT);
    CREATE TABLE IF NOT EXISTS source_sync_meta (key TEXT PRIMARY KEY, lastSync TEXT, extra TEXT);
    CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, data TEXT, updatedAt TEXT, expiresAt INTEGER);
    CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, extra TEXT);
    CREATE TABLE IF NOT EXISTS source_changelogs (id TEXT PRIMARY KEY, sourceId TEXT, extra TEXT);
    CREATE TABLE IF NOT EXISTS customCategories (id TEXT PRIMARY KEY, playlistId TEXT NOT NULL, type TEXT NOT NULL, name TEXT NOT NULL, "order" INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS customCategoryItems (id TEXT PRIMARY KEY, customCategoryId TEXT NOT NULL, playlistId TEXT NOT NULL, type TEXT NOT NULL, upstreamStreamId TEXT NOT NULL, upstreamSourceId TEXT NOT NULL, streamId TEXT NOT NULL, extra TEXT);

    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_sources_userId ON sources(userId);
    CREATE INDEX IF NOT EXISTS idx_epgs_userId ON epgs(userId);
    CREATE INDEX IF NOT EXISTS idx_playlists_userId ON playlists(userId);
    CREATE INDEX IF NOT EXISTS idx_playlists_username ON playlists(username);
    CREATE INDEX IF NOT EXISTS idx_playlists_username_password ON playlists(username, password);
    CREATE INDEX IF NOT EXISTS idx_mappings_playlistId ON mappings(playlistId);
    CREATE INDEX IF NOT EXISTS idx_mappings_playlist_type_orig ON mappings(playlistId, type, originalId);
    CREATE INDEX IF NOT EXISTS idx_categoryMappings_playlistId ON categoryMappings(playlistId);
    CREATE INDEX IF NOT EXISTS idx_categoryMappings_playlist_type_orig ON categoryMappings(playlistId, type, originalId);
    CREATE INDEX IF NOT EXISTS idx_cache_expiresAt ON cache(expiresAt);
    CREATE INDEX IF NOT EXISTS idx_customCategories_playlistId ON customCategories(playlistId, type);
    CREATE INDEX IF NOT EXISTS idx_customCategoryItems_customCategoryId ON customCategoryItems(customCategoryId);
    CREATE INDEX IF NOT EXISTS idx_customCategoryItems_playlistId ON customCategoryItems(playlistId, type);
  `);

  return db;
}

export function getDb(): BetterSQLite3Database<typeof schema> {
  if (!db) throw new Error('Database not connected. Call connectDb() first.');
  return db;
}

export function toId(id: string): string {
  // Return the string directly for SQLite compatibility, or generate a new one if not provided
  return id;
}

export function generateId(): string {
  return crypto.randomUUID();
}

export function docWithId(doc: any): any {
  if (!doc) return null;
  // If we already have id and no _id, we still just return it normalized
  const { _id, extra, ...rest } = doc;
  const idStr = _id ? _id.toString() : doc.id;

  if (extra) {
     return { id: idStr, ...rest, ...extra };
  }
  return { id: idStr, ...rest };
}

export function docsWithId(docs: any[]): any[] {
  return docs.map(docWithId);
}
