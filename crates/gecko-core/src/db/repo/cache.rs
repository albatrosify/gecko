use crate::db::pool::DbPool;
use crate::error::Result;
use crate::models::CacheEntry;
use rusqlite::params;

pub fn get_cache(pool: &DbPool, key: &str) -> Result<Option<CacheEntry>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare("SELECT key, data, updatedAt, expiresAt FROM cache WHERE key = ?1")?;
    let mut rows = stmt.query(params![key])?;

    if let Some(row) = rows.next()? {
        let data_raw: Option<String> = row.get(1)?;
        let data = data_raw.and_then(|s| serde_json::from_str(&s).ok());
        Ok(Some(CacheEntry {
            key: row.get(0)?,
            data,
            updated_at: row.get(2)?,
            expires_at: row.get(3)?,
        }))
    } else {
        Ok(None)
    }
}

pub fn set_cache_sync(
    conn: &mut rusqlite::Connection,
    key: &str,
    data: &serde_json::Value,
    expires_at: Option<i64>,
) -> Result<()> {
    let data_json = serde_json::to_string(data)?;
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO cache (key, data, updatedAt, expiresAt)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(key) DO UPDATE SET
            data = excluded.data,
            updatedAt = excluded.updatedAt,
            expiresAt = excluded.expiresAt",
        params![key, data_json, now, expires_at],
    )?;
    Ok(())
}

pub fn delete_cache_sync(conn: &mut rusqlite::Connection, key: &str) -> Result<()> {
    conn.execute("DELETE FROM cache WHERE key = ?1", params![key])?;
    Ok(())
}

pub fn cleanup_expired_cache_sync(conn: &mut rusqlite::Connection, now_ms: i64) -> Result<usize> {
    let affected = conn.execute(
        "DELETE FROM cache WHERE expiresAt IS NOT NULL AND expiresAt < ?1",
        params![now_ms],
    )?;
    Ok(affected)
}
