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
  // Sync staging tables are only ever transient; keep them out of the disk path.
  sqlite.pragma('temp_store = MEMORY');
  
  db = drizzle(sqlite, { schema });
  
  // Ensure tables and indexes exist (simple auto-migrate for basic setup)
  try {
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
      CREATE TABLE IF NOT EXISTS source_connection_logs (id TEXT PRIMARY KEY, sourceId TEXT NOT NULL, timestamp TEXT NOT NULL, activeCons INTEGER NOT NULL DEFAULT 0, maxCons INTEGER NOT NULL DEFAULT 1, geckoStreams INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'ok', isExternal INTEGER NOT NULL DEFAULT 0, details TEXT, extra TEXT);
      CREATE TABLE IF NOT EXISTS source_host_logs (id TEXT PRIMARY KEY, sourceId TEXT NOT NULL, timestamp TEXT NOT NULL, results TEXT);
      CREATE TABLE IF NOT EXISTS recordings (id TEXT PRIMARY KEY, userId TEXT NOT NULL, playlistId TEXT, sourceId TEXT NOT NULL, streamId TEXT NOT NULL, streamName TEXT NOT NULL, channelName TEXT, type TEXT NOT NULL DEFAULT 'live', status TEXT NOT NULL DEFAULT 'recording', startTime TEXT NOT NULL, endTime TEXT, durationSeconds INTEGER NOT NULL DEFAULT 0, fileSizeBytes INTEGER NOT NULL DEFAULT 0, filePath TEXT NOT NULL, extra TEXT);
      CREATE TABLE IF NOT EXISTS traffic_stats (id TEXT PRIMARY KEY, date TEXT NOT NULL, playlistId TEXT NOT NULL, playlistName TEXT NOT NULL, streamType TEXT NOT NULL, bytes INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL);

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
      CREATE INDEX IF NOT EXISTS idx_source_conn_logs ON source_connection_logs(sourceId, timestamp);
      CREATE INDEX IF NOT EXISTS idx_source_host_logs ON source_host_logs(sourceId, timestamp);
      CREATE INDEX IF NOT EXISTS idx_recordings_userId ON recordings(userId);
      CREATE INDEX IF NOT EXISTS idx_recordings_status ON recordings(status);
      CREATE INDEX IF NOT EXISTS idx_traffic_stats_date ON traffic_stats(date);
      CREATE INDEX IF NOT EXISTS idx_traffic_stats_playlistId ON traffic_stats(playlistId);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_traffic_stats_date_playlist_type ON traffic_stats(date, playlistId, streamType);

      -- Normalised upstream catalog (ADR 0002). Replaces the JSON blobs that used
      -- to live in the cache table and the snapshot blobs in source_sync_meta.
      CREATE TABLE IF NOT EXISTS streams (
        sourceId TEXT NOT NULL,
        type TEXT NOT NULL,
        streamId TEXT NOT NULL,
        name TEXT,
        categoryId TEXT,
        icon TEXT,
        epgChannelId TEXT,
        containerExtension TEXT,
        extra TEXT,
        updatedAt INTEGER NOT NULL,
        PRIMARY KEY (sourceId, type, streamId)
      );
      -- The composite PRIMARY KEY already serves (sourceId, type) prefix lookups,
      -- so no separate index is needed for them.
      CREATE INDEX IF NOT EXISTS idx_streams_source_type_category ON streams(sourceId, type, categoryId);

      -- Name search. The trigram tokenizer makes substring queries index-backed
      -- (SQLite >= 3.34), which is what the playlist search needs. External
      -- content keeps the names out of the index (no duplication) and is fast as
      -- long as queries use MATCH — with LIKE, FTS5 has to re-read every
      -- candidate from the content table (measured ~14 ms vs ~0.2 ms for MATCH).
      --
      -- Deliberately NO triggers: maintaining the index row-by-row during a bulk
      -- sync measured 2.25 s for 51 k rows versus 0.49 s for load + one rebuild.
      -- The writer (server/stream-store.ts) rebuilds it after each replace.
      CREATE VIRTUAL TABLE IF NOT EXISTS streams_fts USING fts5(
        name,
        content='streams',
        content_rowid='rowid',
        tokenize='trigram'
      );

      -- Upgrade cleanup (ADR 0002): the catalog moved into the streams table, so the
      -- old JSON blobs and stream snapshots are dead weight - the better part of the
      -- database on an install that predates this change. GLOB (not LIKE) so the
      -- underscores are matched literally. Sync cooldown rows (<id>_<type>) and the
      -- category snapshot are deliberately preserved.
      DELETE FROM cache
       WHERE key GLOB '*_streams_live' OR key GLOB '*_streams_vod' OR key GLOB '*_streams_series';
      DELETE FROM source_sync_meta
       WHERE key GLOB 'snapshot_*_live'
          OR key GLOB 'snapshot_*_vod'
          OR key GLOB 'snapshot_*_series';
    `);
  } catch (err) {
    console.error('Failed to initialize database schema:', err);
    throw err;
  }

  return db;
}

export function getDb(): BetterSQLite3Database<typeof schema> {
  if (!db) throw new Error('Database not connected. Call connectDb() first.');
  return db;
}

/**
 * Raw `better-sqlite3` handle. Needed for bulk operations (multi-row inserts in
 * a single transaction) and for virtual tables that Drizzle cannot model
 * (e.g. the `streams_fts` full-text index).
 */
export function getSqlite(): Database.Database {
  if (!sqlite) throw new Error('Database not connected. Call connectDb() first.');
  return sqlite;
}

export function generateId(): string {
  return crypto.randomUUID();
}
