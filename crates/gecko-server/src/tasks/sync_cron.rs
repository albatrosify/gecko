use crate::state::AppState;
use gecko_core::repo;
use gecko_core::xtream::XtreamClient;
use std::time::Duration;
use tokio::time::sleep;
use tracing::info;

pub async fn run_sync_cron(state: AppState) {
    info!("Background source sync cron task started");
    loop {
        // Run sync check every 15 minutes
        sleep(Duration::from_secs(900)).await;

        if let Ok(sources) = repo::sources::list_all_sources(&state.db.pool) {
            for source in sources {
                if source.auto_sync_enabled && !source.url.is_empty() {
                    info!("Syncing source '{}' ({})", source.name, source.url);
                    let client = XtreamClient::new(
                        &source.url,
                        source.username.as_deref(),
                        source.password.as_deref(),
                    );
                    if let Ok(auth) = client.authenticate().await {
                        info!(
                            "Source '{}' active: status={}",
                            source.name, auth.user_info.status
                        );
                    }
                }
            }
        }
    }
}
