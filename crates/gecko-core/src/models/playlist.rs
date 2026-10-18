use std::collections::HashMap;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PlaylistSourceOverride {
    pub username: Option<String>,
    pub password: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PlaylistExtra {
    #[serde(rename = "epgIds", default)]
    pub epg_ids: Vec<String>,
    #[serde(rename = "autoUpdateInterval", default)]
    pub auto_update_interval: Option<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(rename = "lastSync", default)]
    pub last_sync: Option<String>,
    #[serde(rename = "qualityLabelFormat", default)]
    pub quality_label_format: Option<String>,
    #[serde(rename = "isSynced", default)]
    pub is_synced: Option<bool>,
    #[serde(rename = "nextStreamId", default)]
    pub next_stream_id: Option<u64>,
    #[serde(rename = "sourceOverrides", default)]
    pub source_overrides: Option<HashMap<String, PlaylistSourceOverride>>,
    #[serde(flatten)]
    pub additional: serde_json::Map<String, serde_json::Value>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Playlist {
    pub id: String,
    pub user_id: String,
    pub name: String,
    pub username: String,
    pub password: String,
    #[serde(default)]
    pub source_ids: Vec<String>,
    #[serde(default)]
    pub direct_streams: bool,
    #[serde(default)]
    pub extra: PlaylistExtra,
}
