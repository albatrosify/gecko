use crate::state::AppState;
use gecko_core::repo;
use std::time::Duration;
use tokio::time::sleep;
use tracing::info;

pub async fn run_traffic_flusher(state: AppState) {
    info!("Background traffic flusher and cache cleaner task started");
    loop {
        sleep(Duration::from_secs(60)).await;

        let now_ms = chrono::Utc::now().timestamp_millis();
        let _ = state
            .db
            .writer
            .write(move |conn| repo::cache::cleanup_expired_cache_sync(conn, now_ms))
            .await;
    }
}
