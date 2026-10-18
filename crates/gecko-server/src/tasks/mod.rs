pub mod sync_cron;
pub mod traffic_flusher;

use crate::state::AppState;

pub fn spawn_background_tasks(state: AppState) {
    tokio::spawn(traffic_flusher::run_traffic_flusher(state.clone()));
    tokio::spawn(sync_cron::run_sync_cron(state));
}
