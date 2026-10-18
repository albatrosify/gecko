use crate::db::pool::DbPool;
use crate::error::Result;
use crate::models::{SourceConnectionLog, SourceHostLog, SourceSyncMeta};
use rusqlite::params;

pub fn get_sync_meta(pool: &DbPool, key: &str) -> Result<Option<SourceSyncMeta>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare("SELECT key, lastSync, extra FROM source_sync_meta WHERE key = ?1")?;
    let mut rows = stmt.query(params![key])?;

    if let Some(row) = rows.next()? {
        let extra_raw: Option<String> = row.get(2)?;
        let extra = extra_raw.and_then(|s| serde_json::from_str(&s).ok());
        Ok(Some(SourceSyncMeta {
            key: row.get(0)?,
            last_sync: row.get(1)?,
            extra,
        }))
    } else {
        Ok(None)
    }
}

pub fn set_sync_meta_sync(conn: &mut rusqlite::Connection, meta: &SourceSyncMeta) -> Result<()> {
    let extra_json = meta.extra.as_ref().map(|e| serde_json::to_string(e).unwrap_or_default());
    conn.execute(
        "INSERT INTO source_sync_meta (key, lastSync, extra)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET
            lastSync = excluded.lastSync,
            extra = excluded.extra",
        params![meta.key, meta.last_sync, extra_json],
    )?;
    Ok(())
}

pub fn insert_connection_log_sync(
    conn: &mut rusqlite::Connection,
    log: &SourceConnectionLog,
) -> Result<()> {
    let extra_json = log.extra.as_ref().map(|e| serde_json::to_string(e).unwrap_or_default());
    conn.execute(
        "INSERT INTO source_connection_logs (id, sourceId, timestamp, activeCons, maxCons, geckoStreams, status, isExternal, details, extra)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            log.id,
            log.source_id,
            log.timestamp,
            log.active_cons,
            log.max_cons,
            log.gecko_streams,
            log.status,
            log.is_external as i32,
            log.details,
            extra_json,
        ],
    )?;
    Ok(())
}

pub fn insert_host_log_sync(conn: &mut rusqlite::Connection, log: &SourceHostLog) -> Result<()> {
    let results_json = log.results.as_ref().map(|r| serde_json::to_string(r).unwrap_or_default());
    conn.execute(
        "INSERT INTO source_host_logs (id, sourceId, timestamp, results)
         VALUES (?1, ?2, ?3, ?4)",
        params![log.id, log.source_id, log.timestamp, results_json],
    )?;
    Ok(())
}

pub fn list_connection_logs(pool: &DbPool, source_id: &str, limit: u32) -> Result<Vec<SourceConnectionLog>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare(
        "SELECT id, sourceId, timestamp, activeCons, maxCons, geckoStreams, status, isExternal, details, extra 
         FROM source_connection_logs WHERE sourceId = ?1 ORDER BY timestamp DESC LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![source_id, limit], |row| {
        let is_ext_int: i32 = row.get(7)?;
        let extra_raw: Option<String> = row.get(9)?;
        let extra = extra_raw.and_then(|s| serde_json::from_str(&s).ok());

        Ok(SourceConnectionLog {
            id: row.get(0)?,
            source_id: row.get(1)?,
            timestamp: row.get(2)?,
            active_cons: row.get(3)?,
            max_cons: row.get(4)?,
            gecko_streams: row.get(5)?,
            status: row.get(6)?,
            is_external: is_ext_int != 0,
            details: row.get(7)?,
            extra,
        })
    })?;

    let mut logs = Vec::new();
    for l in rows {
        logs.push(l?);
    }
    Ok(logs)
}
