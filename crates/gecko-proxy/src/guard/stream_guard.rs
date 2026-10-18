use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GuardDecision {
    AllowNew,
    JoinExisting { channel_key: String },
    BlockConflict { source_id: String, max_cons: u32 },
}

#[derive(Default, Clone)]
pub struct StreamGuard {
    active_channels_by_source: Arc<RwLock<HashMap<String, Vec<String>>>>,
}

impl StreamGuard {
    pub fn new() -> Self {
        Self {
            active_channels_by_source: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn evaluate(
        &self,
        source_id: &str,
        stream_id: &str,
        max_connections: u32,
        concurrency_guard_enabled: bool,
    ) -> GuardDecision {
        let active = self.active_channels_by_source.read().await;
        let active_streams = active.get(source_id).cloned().unwrap_or_default();

        let channel_key = format!("{}_{}", source_id, stream_id);

        // If the exact channel is already running, join it with zero additional upstream load!
        if active_streams.contains(&stream_id.to_string()) {
            return GuardDecision::JoinExisting { channel_key };
        }

        // If guard is enabled and active connections have reached the maximum allowed:
        if concurrency_guard_enabled && active_streams.len() >= max_connections as usize {
            return GuardDecision::BlockConflict {
                source_id: source_id.to_string(),
                max_cons: max_connections,
            };
        }

        GuardDecision::AllowNew
    }

    pub async fn register_stream(&self, source_id: &str, stream_id: &str) {
        let mut active = self.active_channels_by_source.write().await;
        let list = active.entry(source_id.to_string()).or_default();
        if !list.contains(&stream_id.to_string()) {
            list.push(stream_id.to_string());
        }
    }

    pub async fn unregister_stream(&self, source_id: &str, stream_id: &str) {
        let mut active = self.active_channels_by_source.write().await;
        if let Some(list) = active.get_mut(source_id) {
            list.retain(|s| s != stream_id);
        }
    }
}
