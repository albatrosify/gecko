use crate::db::pool::DbPool;
use crate::error::{CoreError, Result};
use crate::models::{Playlist, PlaylistExtra};
use rusqlite::params;

fn map_playlist_row(row: &rusqlite::Row) -> rusqlite::Result<Playlist> {
    let source_ids_raw: Option<String> = row.get(5)?;
    let source_ids: Vec<String> = source_ids_raw
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();

    let direct_int: Option<i32> = row.get(6)?;
    let direct_streams = direct_int.map(|v| v != 0).unwrap_or(false);

    let extra_raw: Option<String> = row.get(7)?;
    let extra = extra_raw
        .and_then(|s| serde_json::from_str::<PlaylistExtra>(&s).ok())
        .unwrap_or_default();

    Ok(Playlist {
        id: row.get(0)?,
        user_id: row.get(1)?,
        name: row.get(2)?,
        username: row.get(3)?,
        password: row.get(4)?,
        source_ids,
        direct_streams,
        extra,
    })
}

pub fn get_playlist_by_id(pool: &DbPool, id: &str) -> Result<Option<Playlist>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare(
        "SELECT id, userId, name, username, password, sourceIds, directStreams, extra 
         FROM playlists WHERE id = ?1",
    )?;
    let mut rows = stmt.query(params![id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(map_playlist_row(row)?))
    } else {
        Ok(None)
    }
}

pub fn get_playlist_by_credentials(pool: &DbPool, username: &str, password: &str) -> Result<Option<Playlist>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare(
        "SELECT id, userId, name, username, password, sourceIds, directStreams, extra 
         FROM playlists WHERE username = ?1 AND password = ?2",
    )?;
    let mut rows = stmt.query(params![username, password])?;
    if let Some(row) = rows.next()? {
        Ok(Some(map_playlist_row(row)?))
    } else {
        Ok(None)
    }
}

pub fn get_playlist_by_username(pool: &DbPool, username: &str) -> Result<Option<Playlist>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare(
        "SELECT id, userId, name, username, password, sourceIds, directStreams, extra 
         FROM playlists WHERE username = ?1",
    )?;
    let mut rows = stmt.query(params![username])?;
    if let Some(row) = rows.next()? {
        Ok(Some(map_playlist_row(row)?))
    } else {
        Ok(None)
    }
}

pub fn list_playlists_by_user(pool: &DbPool, user_id: &str) -> Result<Vec<Playlist>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare(
        "SELECT id, userId, name, username, password, sourceIds, directStreams, extra 
         FROM playlists WHERE userId = ?1",
    )?;
    let rows = stmt.query_map(params![user_id], map_playlist_row)?;
    let mut playlists = Vec::new();
    for p in rows {
        playlists.push(p?);
    }
    Ok(playlists)
}

pub fn list_all_playlists(pool: &DbPool) -> Result<Vec<Playlist>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare(
        "SELECT id, userId, name, username, password, sourceIds, directStreams, extra 
         FROM playlists",
    )?;
    let rows = stmt.query_map([], map_playlist_row)?;
    let mut playlists = Vec::new();
    for p in rows {
        playlists.push(p?);
    }
    Ok(playlists)
}

pub fn insert_playlist_sync(conn: &mut rusqlite::Connection, playlist: &Playlist) -> Result<()> {
    let source_ids_json = serde_json::to_string(&playlist.source_ids)?;
    let extra_json = serde_json::to_string(&playlist.extra)?;
    conn.execute(
        "INSERT INTO playlists (id, userId, name, username, password, sourceIds, directStreams, extra)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            playlist.id,
            playlist.user_id,
            playlist.name,
            playlist.username,
            playlist.password,
            source_ids_json,
            playlist.direct_streams as i32,
            extra_json,
        ],
    )?;
    Ok(())
}

pub fn update_playlist_sync(conn: &mut rusqlite::Connection, playlist: &Playlist) -> Result<()> {
    let source_ids_json = serde_json::to_string(&playlist.source_ids)?;
    let extra_json = serde_json::to_string(&playlist.extra)?;
    let affected = conn.execute(
        "UPDATE playlists SET name = ?1, username = ?2, password = ?3, sourceIds = ?4, 
         directStreams = ?5, extra = ?6 WHERE id = ?7",
        params![
            playlist.name,
            playlist.username,
            playlist.password,
            source_ids_json,
            playlist.direct_streams as i32,
            extra_json,
            playlist.id,
        ],
    )?;
    if affected == 0 {
        return Err(CoreError::NotFound(format!("Playlist {} not found", playlist.id)));
    }
    Ok(())
}

pub fn upsert_playlist_sync(conn: &mut rusqlite::Connection, playlist: &Playlist) -> Result<()> {
    let source_ids_json = serde_json::to_string(&playlist.source_ids)?;
    let extra_json = serde_json::to_string(&playlist.extra)?;
    conn.execute(
        "INSERT INTO playlists (id, userId, name, username, password, sourceIds, directStreams, extra)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(id) DO UPDATE SET 
            name = excluded.name,
            username = excluded.username,
            password = excluded.password,
            sourceIds = excluded.sourceIds,
            directStreams = excluded.directStreams,
            extra = excluded.extra",
        params![
            playlist.id,
            playlist.user_id,
            playlist.name,
            playlist.username,
            playlist.password,
            source_ids_json,
            playlist.direct_streams as i32,
            extra_json,
        ],
    )?;
    Ok(())
}

pub fn delete_playlist_sync(conn: &mut rusqlite::Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM playlists WHERE id = ?1", params![id])?;
    Ok(())
}
