use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StreamType {
    Live,
    Vod,
    Series,
}

impl StreamType {
    pub fn as_str(&self) -> &'static str {
        match self {
            StreamType::Live => "live",
            StreamType::Vod => "vod",
            StreamType::Series => "series",
        }
    }

    pub fn from_str_opt(s: &str) -> Option<Self> {
        match s.to_ascii_lowercase().as_str() {
            "live" => Some(StreamType::Live),
            "vod" => Some(StreamType::Vod),
            "series" => Some(StreamType::Series),
            _ => None,
        }
    }
}

impl std::fmt::Display for StreamType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RegexRename {
    #[serde(rename = "type", default)]
    pub rename_type: Option<String>,
    pub pattern: String,
    pub replacement: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DetectedStreamMeta {
    #[serde(default)]
    pub resolution: Option<String>,
    #[serde(default)]
    pub video_codec: Option<String>,
    #[serde(default)]
    pub hdr: Option<String>,
    #[serde(default)]
    pub fps: Option<f64>,
    #[serde(default)]
    pub audio_codec: Option<String>,
    #[serde(default)]
    pub audio_channels: Option<u32>,
    #[serde(default)]
    pub scanned_at: Option<String>,
    #[serde(default)]
    pub scan_type: Option<String>,
    #[serde(default)]
    pub color_depth: Option<u32>,
    #[serde(default)]
    pub audio_layout: Option<String>,
    #[serde(default)]
    pub video_profile: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StreamMappingExtra {
    #[serde(default)]
    pub order: i32,
    #[serde(default)]
    pub source_idx: Option<usize>,
    #[serde(default)]
    pub category_id: Option<String>,
    #[serde(default)]
    pub original_name: Option<String>,
    #[serde(default)]
    pub custom_name: Option<String>,
    #[serde(default)]
    pub custom_icon: Option<String>,
    #[serde(default)]
    pub epg_mapping: Option<String>,
    #[serde(default)]
    pub epg_icon: Option<String>,
    #[serde(default)]
    pub epg_source: Option<String>,
    #[serde(default)]
    pub hidden: bool,
    #[serde(default)]
    pub regex_renames: Option<Vec<RegexRename>>,
    #[serde(default)]
    pub detected_meta: Option<DetectedStreamMeta>,
    #[serde(default)]
    pub use_detected_quality: Option<bool>,
    #[serde(flatten)]
    pub additional: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamMapping {
    pub id: String,
    pub playlist_id: String,
    #[serde(rename = "type")]
    pub mapping_type: StreamType,
    pub original_id: String,
    #[serde(flatten, default)]
    pub extra: StreamMappingExtra,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CategoryMappingExtra {
    #[serde(default)]
    pub order: i32,
    #[serde(default)]
    pub original_name: Option<String>,
    #[serde(default)]
    pub custom_name: Option<String>,
    #[serde(default)]
    pub hidden: bool,
    #[serde(default)]
    pub sync_on_demand: Option<bool>,
    #[serde(flatten)]
    pub additional: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryMapping {
    pub id: String,
    pub playlist_id: String,
    #[serde(rename = "type")]
    pub mapping_type: StreamType,
    pub original_id: String,
    #[serde(flatten, default)]
    pub extra: CategoryMappingExtra,
}
