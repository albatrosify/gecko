use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceSyncMeta {
    pub key: String,
    pub last_sync: Option<String>,
    #[serde(default)]
    pub extra: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceChangelog {
    pub id: String,
    pub source_id: Option<String>,
    #[serde(default)]
    pub extra: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceConnectionLog {
    pub id: String,
    pub source_id: String,
    pub timestamp: String,
    #[serde(default)]
    pub active_cons: u32,
    #[serde(default = "default_one")]
    pub max_cons: u32,
    #[serde(default)]
    pub gecko_streams: u32,
    #[serde(default = "default_ok")]
    pub status: String,
    #[serde(default)]
    pub is_external: bool,
    #[serde(default)]
    pub details: Option<String>,
    #[serde(default)]
    pub extra: Option<serde_json::Value>,
}

fn default_one() -> u32 {
    1
}

fn default_ok() -> String {
    "ok".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceHostLog {
    pub id: String,
    pub source_id: String,
    pub timestamp: String,
    #[serde(default)]
    pub results: Option<serde_json::Value>,
}
