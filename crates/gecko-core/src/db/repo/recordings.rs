use crate::db::pool::DbPool;
use crate::error::{CoreError, Result};
use crate::models::{recording_id_to_numeric, Recording, RecordingStatus, StreamType};
use rusqlite::params;
use tracing::info;

fn map_recording_row(row: &rusqlite::Row) -> rusqlite::Result<Recording> {
    let type_str: String = row.get(7)?;
    let stream_type = StreamType::from_str_opt(&type_str).unwrap_or(StreamType::Live);
    let status_str: String = row.get(8)?;
    let status = RecordingStatus::from_str_opt(&status_str).unwrap_or(RecordingStatus::Recording);
    let extra_raw: Option<String> = row.get(14)?;
    let extra = extra_raw.and_then(|s| serde_json::from_str(&s).ok());

    Ok(Recording {
        id: row.get(0)?,
        user_id: row.get(1)?,
        playlist_id: row.get(2)?,
        source_id: row.get(3)?,
        stream_id: row.get(4)?,
        stream_name: row.get(5)?,
        channel_name: row.get(6)?,
        stream_type,
        status,
        start_time: row.get(9)?,
        end_time: row.get(10)?,
        duration_seconds: row.get(11)?,
        file_size_bytes: row.get(12)?,
        file_path: row.get(13)?,
        extra,
    })
}

pub fn get_recording_by_id(pool: &DbPool, id: &str) -> Result<Option<Recording>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare(
        "SELECT id, userId, playlistId, sourceId, streamId, streamName, channelName, type, status, 
                startTime, endTime, durationSeconds, fileSizeBytes, filePath, extra 
         FROM recordings WHERE id = ?1",
    )?;
    let mut rows = stmt.query(params![id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(map_recording_row(row)?))
    } else {
        Ok(None)
    }
}

pub fn get_recording_by_numeric_id(pool: &DbPool, numeric_id: u32) -> Result<Option<Recording>> {
    let recordings = list_all_recordings(pool)?;
    for r in recordings {
        if recording_id_to_numeric(&r.id) == numeric_id {
            return Ok(Some(r));
        }
    }
    Ok(None)
}

pub fn list_recordings_by_user(pool: &DbPool, user_id: &str) -> Result<Vec<Recording>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare(
        "SELECT id, userId, playlistId, sourceId, streamId, streamName, channelName, type, status, 
                startTime, endTime, durationSeconds, fileSizeBytes, filePath, extra 
         FROM recordings WHERE userId = ?1 ORDER BY startTime DESC",
    )?;
    let rows = stmt.query_map(params![user_id], map_recording_row)?;
    let mut recordings = Vec::new();
    for r in rows {
        recordings.push(r?);
    }
    Ok(recordings)
}

pub fn list_all_recordings(pool: &DbPool) -> Result<Vec<Recording>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare(
        "SELECT id, userId, playlistId, sourceId, streamId, streamName, channelName, type, status, 
                startTime, endTime, durationSeconds, fileSizeBytes, filePath, extra 
         FROM recordings ORDER BY startTime DESC",
    )?;
    let rows = stmt.query_map([], map_recording_row)?;
    let mut recordings = Vec::new();
    for r in rows {
        recordings.push(r?);
    }
    Ok(recordings)
}

pub fn insert_recording_sync(conn: &mut rusqlite::Connection, rec: &Recording) -> Result<()> {
    let extra_json = rec.extra.as_ref().map(|e| serde_json::to_string(e).unwrap_or_default());
    conn.execute(
        "INSERT INTO recordings (id, userId, playlistId, sourceId, streamId, streamName, channelName, 
                                type, status, startTime, endTime, durationSeconds, fileSizeBytes, filePath, extra)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
        params![
            rec.id,
            rec.user_id,
            rec.playlist_id,
            rec.source_id,
            rec.stream_id,
            rec.stream_name,
            rec.channel_name,
            rec.stream_type.as_str(),
            rec.status.as_str(),
            rec.start_time,
            rec.end_time,
            rec.duration_seconds,
            rec.file_size_bytes,
            rec.file_path,
            extra_json,
        ],
    )?;
    Ok(())
}

pub fn update_recording_sync(conn: &mut rusqlite::Connection, rec: &Recording) -> Result<()> {
    let extra_json = rec.extra.as_ref().map(|e| serde_json::to_string(e).unwrap_or_default());
    let affected = conn.execute(
        "UPDATE recordings SET playlistId = ?1, sourceId = ?2, streamId = ?3, streamName = ?4, 
                channelName = ?5, type = ?6, status = ?7, startTime = ?8, endTime = ?9, 
                durationSeconds = ?10, fileSizeBytes = ?11, filePath = ?12, extra = ?13 
         WHERE id = ?14",
        params![
            rec.playlist_id,
            rec.source_id,
            rec.stream_id,
            rec.stream_name,
            rec.channel_name,
            rec.stream_type.as_str(),
            rec.status.as_str(),
            rec.start_time,
            rec.end_time,
            rec.duration_seconds,
            rec.file_size_bytes,
            rec.file_path,
            extra_json,
            rec.id,
        ],
    )?;
    if affected == 0 {
        return Err(CoreError::NotFound(format!("Recording {} not found", rec.id)));
    }
    Ok(())
}

pub fn delete_recording_sync(conn: &mut rusqlite::Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM recordings WHERE id = ?1", params![id])?;
    Ok(())
}

/// Sets all 'recording' status entries to 'completed' on server startup.
/// Prevents orphaned active streams after server crashes or restarts.
pub fn reconcile_orphaned_recordings_sync(conn: &mut rusqlite::Connection) -> Result<usize> {
    let affected = conn.execute(
        "UPDATE recordings SET status = 'completed' WHERE status = 'recording'",
        [],
    )?;
    if affected > 0 {
        info!("Reconciled {} orphaned recording(s) to 'completed' status", affected);
    }
    Ok(affected)
}
