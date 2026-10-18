use crate::error::Result;
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use std::path::Path;

pub type DbPool = Pool<SqliteConnectionManager>;

pub fn create_pool<P: AsRef<Path>>(db_path: P, max_size: u32) -> Result<DbPool> {
    let path = db_path.as_ref();
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent).map_err(|e| {
                crate::error::CoreError::Other(format!("Failed to create db dir: {}", e))
            })?;
        }
    }

    let manager = SqliteConnectionManager::file(path).with_init(|conn| {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 5000;
             PRAGMA cache_size = -64000;",
        )
    });

    let pool = Pool::builder().max_size(max_size).build(manager)?;

    // Run initial migration on a borrowed connection
    {
        let conn = pool.get()?;
        super::schema::migrate(&conn)?;
    }

    Ok(pool)
}
