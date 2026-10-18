use crate::error::Result;
use rusqlite::Connection;
use tracing::info;

pub const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    role TEXT NOT NULL,
    createdAt INTEGER
);

CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    url TEXT NOT NULL,
    username TEXT,
    password TEXT,
    autoSyncEnabled INTEGER,
    syncCron TEXT,
    extra TEXT
);

CREATE TABLE IF NOT EXISTS epgs (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    extra TEXT
);

CREATE TABLE IF NOT EXISTS playlists (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    name TEXT NOT NULL,
    username TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    sourceIds TEXT,
    directStreams INTEGER,
    extra TEXT
);

CREATE TABLE IF NOT EXISTS mappings (
    id TEXT PRIMARY KEY,
    playlistId TEXT NOT NULL,
    type TEXT NOT NULL,
    originalId TEXT NOT NULL,
    extra TEXT
);

CREATE TABLE IF NOT EXISTS categoryMappings (
    id TEXT PRIMARY KEY,
    playlistId TEXT NOT NULL,
    type TEXT NOT NULL,
    originalId TEXT NOT NULL,
    extra TEXT
);

CREATE TABLE IF NOT EXISTS source_sync_meta (
    key TEXT PRIMARY KEY,
    lastSync TEXT,
    extra TEXT
);

CREATE TABLE IF NOT EXISTS cache (
    key TEXT PRIMARY KEY,
    data TEXT,
    updatedAt TEXT,
    expiresAt INTEGER
);

CREATE TABLE IF NOT EXISTS settings (
    id TEXT PRIMARY KEY,
    extra TEXT
);

CREATE TABLE IF NOT EXISTS source_changelogs (
    id TEXT PRIMARY KEY,
    sourceId TEXT,
    extra TEXT
);

CREATE TABLE IF NOT EXISTS customCategories (
    id TEXT PRIMARY KEY,
    playlistId TEXT NOT NULL,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    hidden INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS customCategoryItems (
    id TEXT PRIMARY KEY,
    customCategoryId TEXT NOT NULL,
    playlistId TEXT NOT NULL,
    type TEXT NOT NULL,
    upstreamStreamId TEXT NOT NULL,
    upstreamSourceId TEXT NOT NULL,
    streamId TEXT NOT NULL,
    extra TEXT
);

CREATE TABLE IF NOT EXISTS source_connection_logs (
    id TEXT PRIMARY KEY,
    sourceId TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    activeCons INTEGER NOT NULL DEFAULT 0,
    maxCons INTEGER NOT NULL DEFAULT 1,
    geckoStreams INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'ok',
    isExternal INTEGER NOT NULL DEFAULT 0,
    details TEXT,
    extra TEXT
);

CREATE TABLE IF NOT EXISTS source_host_logs (
    id TEXT PRIMARY KEY,
    sourceId TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    results TEXT
);

CREATE TABLE IF NOT EXISTS recordings (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    playlistId TEXT,
    sourceId TEXT NOT NULL,
    streamId TEXT NOT NULL,
    streamName TEXT NOT NULL,
    channelName TEXT,
    type TEXT NOT NULL DEFAULT 'live',
    status TEXT NOT NULL DEFAULT 'recording',
    startTime TEXT NOT NULL,
    endTime TEXT,
    durationSeconds INTEGER NOT NULL DEFAULT 0,
    fileSizeBytes INTEGER NOT NULL DEFAULT 0,
    filePath TEXT NOT NULL,
    extra TEXT
);

CREATE TABLE IF NOT EXISTS traffic_stats (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    playlistId TEXT NOT NULL,
    playlistName TEXT NOT NULL,
    streamType TEXT NOT NULL,
    bytes INTEGER NOT NULL DEFAULT 0,
    updatedAt INTEGER NOT NULL
);

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
"#;

pub fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;")?;
    conn.execute_batch(SCHEMA_SQL)?;
    info!("SQLite database migration completed successfully (WAL mode enabled)");
    Ok(())
}
