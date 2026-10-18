use std::collections::HashMap;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistSourceOverride {
    pub username: Option<String>,
    pub password: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistExtra {
    #[serde(default)]
    pub epg_ids: Vec<String>,
    #[serde(default)]
    pub auto_update_interval: Option<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub last_sync: Option<String>,
    #[serde(default)]
    pub quality_label_format: Option<String>,
    #[serde(default)]
    pub is_synced: Option<bool>,
    #[serde(default)]
    pub next_stream_id: Option<u64>,
    #[serde(default)]
    pub source_overrides: Option<HashMap<String, PlaylistSourceOverride>>,
    #[serde(flatten)]
    pub additional: serde_json::Map<String, serde_json::Value>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
    #[serde(flatten, default)]
    pub extra: PlaylistExtra,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_playlist_json_camel_case_and_flatten() {
        let p = Playlist {
            id: "p1".into(),
            user_id: "u1".into(),
            name: "Test Playlist".into(),
            username: "user".into(),
            password: "pass".into(),
            source_ids: vec!["s1".into(), "s2".into()],
            direct_streams: true,
            extra: PlaylistExtra {
                epg_ids: vec!["epg1".into()],
                enabled: true,
                ..Default::default()
            },
        };

        let val = serde_json::to_value(&p).unwrap();
        assert_eq!(val["id"], "p1");
        assert_eq!(val["userId"], "u1");
        assert_eq!(val["sourceIds"], serde_json::json!(["s1", "s2"]));
        assert_eq!(val["directStreams"], true);
        assert_eq!(val["epgIds"], serde_json::json!(["epg1"]));
        assert_eq!(val["enabled"], true);
    }
}
