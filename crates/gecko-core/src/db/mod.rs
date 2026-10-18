pub mod actor;
pub mod pool;
pub mod repo;
pub mod schema;

pub use actor::DbWriterHandle;
pub use pool::{create_pool, DbPool};

use crate::error::Result;
use std::path::Path;

#[derive(Clone)]
pub struct Database {
    pub pool: DbPool,
    pub writer: DbWriterHandle,
}

impl Database {
    pub fn open<P: AsRef<Path>>(path: P) -> Result<Self> {
        let pool = create_pool(&path, 32)?;
        let writer = DbWriterHandle::new(&path, 1024)?;
        Ok(Self { pool, writer })
    }

    pub fn in_memory() -> Result<Self> {
        // For unit tests: unique temp file
        let db_path = std::env::temp_dir().join(format!("gecko_test_{}.db", uuid::Uuid::new_v4()));
        Self::open(db_path)
    }
}
