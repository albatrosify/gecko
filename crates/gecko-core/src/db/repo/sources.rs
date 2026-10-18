use crate::db::pool::DbPool;
use crate::error::{CoreError, Result};
use crate::models::{Source, SourceExtra, SourceType};
use rusqlite::params;

fn map_source_row(row: &rusqlite::Row) -> rusqlite::Result<Source> {
    let type_str: String = row.get(3)?;
    let source_type = SourceType::from_str_opt(&type_str).unwrap_or(SourceType::Xtream);
    let auto_sync_int: Option<i32> = row.get(7)?;
    let auto_sync_enabled = auto_sync_int.map(|v| v != 0).unwrap_or(false);
    let extra_raw: Option<String> = row.get(9)?;
    let extra = extra_raw
        .and_then(|s| serde_json::from_str::<SourceExtra>(&s).ok())
        .unwrap_or_default();

    Ok(Source {
        id: row.get(0)?,
        user_id: row.get(1)?,
        name: row.get(2)?,
        source_type,
        url: row.get(4)?,
        username: row.get(5)?,
        password: row.get(6)?,
        auto_sync_enabled,
        sync_cron: row.get(8)?,
        extra,
    })
}

pub fn get_source_by_id(pool: &DbPool, id: &str) -> Result<Option<Source>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare(
        "SELECT id, userId, name, type, url, username, password, autoSyncEnabled, syncCron, extra 
         FROM sources WHERE id = ?1",
    )?;
    let mut rows = stmt.query(params![id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(map_source_row(row)?))
    } else {
        Ok(None)
    }
}

pub fn list_sources_by_user(pool: &DbPool, user_id: &str) -> Result<Vec<Source>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare(
        "SELECT id, userId, name, type, url, username, password, autoSyncEnabled, syncCron, extra 
         FROM sources WHERE userId = ?1",
    )?;
    let rows = stmt.query_map(params![user_id], map_source_row)?;
    let mut sources = Vec::new();
    for s in rows {
        sources.push(s?);
    }
    Ok(sources)
}

pub fn list_all_sources(pool: &DbPool) -> Result<Vec<Source>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare(
        "SELECT id, userId, name, type, url, username, password, autoSyncEnabled, syncCron, extra 
         FROM sources",
    )?;
    let rows = stmt.query_map([], map_source_row)?;
    let mut sources = Vec::new();
    for s in rows {
        sources.push(s?);
    }
    Ok(sources)
}

pub fn get_sources_by_ids(pool: &DbPool, ids: &[String]) -> Result<Vec<Source>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let conn = pool.get()?;
    let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let query = format!(
        "SELECT id, userId, name, type, url, username, password, autoSyncEnabled, syncCron, extra 
         FROM sources WHERE id IN ({})",
        placeholders
    );
    let mut stmt = conn.prepare(&query)?;
    let rusqlite_params = rusqlite::params_from_iter(ids);
    let rows = stmt.query_map(rusqlite_params, map_source_row)?;
    let mut sources = Vec::new();
    for s in rows {
        sources.push(s?);
    }
    Ok(sources)
}

pub fn insert_source_sync(conn: &mut rusqlite::Connection, source: &Source) -> Result<()> {
    let extra_json = serde_json::to_string(&source.extra)?;
    conn.execute(
        "INSERT INTO sources (id, userId, name, type, url, username, password, autoSyncEnabled, syncCron, extra)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            source.id,
            source.user_id,
            source.name,
            source.source_type.as_str(),
            source.url,
            source.username,
            source.password,
            source.auto_sync_enabled as i32,
            source.sync_cron,
            extra_json,
        ],
    )?;
    Ok(())
}

pub fn update_source_sync(conn: &mut rusqlite::Connection, source: &Source) -> Result<()> {
    let extra_json = serde_json::to_string(&source.extra)?;
    let affected = conn.execute(
        "UPDATE sources SET name = ?1, type = ?2, url = ?3, username = ?4, password = ?5, 
         autoSyncEnabled = ?6, syncCron = ?7, extra = ?8 WHERE id = ?9",
        params![
            source.name,
            source.source_type.as_str(),
            source.url,
            source.username,
            source.password,
            source.auto_sync_enabled as i32,
            source.sync_cron,
            extra_json,
            source.id,
        ],
    )?;
    if affected == 0 {
        return Err(CoreError::NotFound(format!("Source {} not found", source.id)));
    }
    Ok(())
}

pub fn delete_source_sync(conn: &mut rusqlite::Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM sources WHERE id = ?1", params![id])?;
    Ok(())
}
