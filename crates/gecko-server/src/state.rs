use gecko_core::Database;
use gecko_proxy::dvr::DvrRecorder;
use gecko_proxy::guard::StreamGuard;
use gecko_proxy::multiplexer::StreamHub;

#[derive(Clone)]
pub struct AppState {
    pub db: Database,
    pub hub: StreamHub,
    pub guard: StreamGuard,
    pub dvr: DvrRecorder,
}

impl AppState {
    pub fn new(db: Database) -> Self {
        let reserve_secs = std::env::var("GECKO_LIVE_BUFFER_SECONDS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(12);

        Self {
            db,
            hub: StreamHub::new(reserve_secs),
            guard: StreamGuard::new(),
            dvr: DvrRecorder::new(),
        }
    }
}
