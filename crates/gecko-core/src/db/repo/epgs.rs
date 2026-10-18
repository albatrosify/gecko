use crate::db::pool::DbPool;
use crate::error::Result;
use crate::models::EpgSource;
use rusqlite::params;

fn map_epg_row(row: &rusqlite::Row) -> rusqlite::Result<EpgSource> {
    let extra_raw: Option<String> = row.get(4)?;
    let extra: serde_json::Map<String, serde_json::Value> = extra_raw
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();

    let enabled = extra
        .get("enabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);

    Ok(EpgSource {
        id: row.get(0)?,
        user_id: row.get(1)?,
        name: row.get(2)?,
        url: row.get(3)?,
        enabled,
        extra,
    })
}

pub fn list_epgs_by_user(pool: &DbPool, user_id: &str) -> Result<Vec<EpgSource>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare("SELECT id, userId, name, url, extra FROM epgs WHERE userId = ?1")?;
    let rows = stmt.query_map(params![user_id], map_epg_row)?;
    let mut list = Vec::new();
    for e in rows {
        list.push(e?);
    }
    Ok(list)
}

pub fn get_epg_by_id(pool: &DbPool, id: &str) -> Result<Option<EpgSource>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare("SELECT id, userId, name, url, extra FROM epgs WHERE id = ?1")?;
    let mut rows = stmt.query(params![id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(map_epg_row(row)?))
    } else {
        Ok(None)
    }
}

pub fn insert_epg_sync(conn: &mut rusqlite::Connection, epg: &EpgSource) -> Result<()> {
    let extra_json = serde_json::to_string(&epg.extra)?;
    conn.execute(
        "INSERT INTO epgs (id, userId, name, url, extra) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![epg.id, epg.user_id, epg.name, epg.url, extra_json],
    )?;
    Ok(())
}

pub fn delete_epg_sync(conn: &mut rusqlite::Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM epgs WHERE id = ?1", params![id])?;
    Ok(())
}
