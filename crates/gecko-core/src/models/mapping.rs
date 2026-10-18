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
pub struct RegexRename {
    #[serde(rename = "type", default)]
    pub rename_type: Option<String>,
    pub pattern: String,
    pub replacement: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DetectedStreamMeta {
    #[serde(default)]
    pub resolution: Option<String>,
    #[serde(rename = "videoCodec", default)]
    pub video_codec: Option<String>,
    #[serde(default)]
    pub hdr: Option<String>,
    #[serde(default)]
    pub fps: Option<f64>,
    #[serde(rename = "audioCodec", default)]
    pub audio_codec: Option<String>,
    #[serde(rename = "audioChannels", default)]
    pub audio_channels: Option<u32>,
    #[serde(rename = "scannedAt", default)]
    pub scanned_at: Option<String>,
    #[serde(rename = "scanType", default)]
    pub scan_type: Option<String>,
    #[serde(rename = "colorDepth", default)]
    pub color_depth: Option<u32>,
    #[serde(rename = "audioLayout", default)]
    pub audio_layout: Option<String>,
    #[serde(rename = "videoProfile", default)]
    pub video_profile: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct StreamMappingExtra {
    #[serde(default)]
    pub order: i32,
    #[serde(rename = "sourceIdx", default)]
    pub source_idx: Option<usize>,
    #[serde(rename = "categoryId", default)]
    pub category_id: Option<String>,
    #[serde(rename = "originalName", default)]
    pub original_name: Option<String>,
    #[serde(rename = "customName", default)]
    pub custom_name: Option<String>,
    #[serde(rename = "customIcon", default)]
    pub custom_icon: Option<String>,
    #[serde(rename = "epgMapping", default)]
    pub epg_mapping: Option<String>,
    #[serde(rename = "epgIcon", default)]
    pub epg_icon: Option<String>,
    #[serde(rename = "epgSource", default)]
    pub epg_source: Option<String>,
    #[serde(default)]
    pub hidden: bool,
    #[serde(rename = "regexRenames", default)]
    pub regex_renames: Option<Vec<RegexRename>>,
    #[serde(rename = "detectedMeta", default)]
    pub detected_meta: Option<DetectedStreamMeta>,
    #[serde(rename = "useDetectedQuality", default)]
    pub use_detected_quality: Option<bool>,
    #[serde(flatten)]
    pub additional: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamMapping {
    pub id: String,
    pub playlist_id: String,
    #[serde(rename = "type")]
    pub mapping_type: StreamType,
    pub original_id: String,
    #[serde(default)]
    pub extra: StreamMappingExtra,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CategoryMappingExtra {
    #[serde(default)]
    pub order: i32,
    #[serde(rename = "originalName", default)]
    pub original_name: Option<String>,
    #[serde(rename = "customName", default)]
    pub custom_name: Option<String>,
    #[serde(default)]
    pub hidden: bool,
    #[serde(rename = "syncOnDemand", default)]
    pub sync_on_demand: Option<bool>,
    #[serde(flatten)]
    pub additional: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CategoryMapping {
    pub id: String,
    pub playlist_id: String,
    #[serde(rename = "type")]
    pub mapping_type: StreamType,
    pub original_id: String,
    #[serde(default)]
    pub extra: CategoryMappingExtra,
}
