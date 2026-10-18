use crate::db::pool::DbPool;
use crate::error::Result;
use rusqlite::params;

pub fn get_setting(pool: &DbPool, id: &str) -> Result<Option<serde_json::Value>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare("SELECT extra FROM settings WHERE id = ?1")?;
    let mut rows = stmt.query(params![id])?;
    if let Some(row) = rows.next()? {
        let raw: Option<String> = row.get(0)?;
        let val = raw.and_then(|s| serde_json::from_str(&s).ok());
        Ok(val)
    } else {
        Ok(None)
    }
}

pub fn upsert_setting_sync(conn: &mut rusqlite::Connection, id: &str, extra: &serde_json::Value) -> Result<()> {
    let extra_json = serde_json::to_string(extra)?;
    conn.execute(
        "INSERT INTO settings (id, extra) VALUES (?1, ?2)
         ON CONFLICT(id) DO UPDATE SET extra = excluded.extra",
        params![id, extra_json],
    )?;
    Ok(())
}
