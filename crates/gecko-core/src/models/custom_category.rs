use super::mapping::StreamType;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomCategory {
    pub id: String,
    pub playlist_id: String,
    #[serde(rename = "type")]
    pub custom_type: StreamType,
    pub name: String,
    #[serde(default)]
    pub order: i32,
    #[serde(default)]
    pub hidden: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomCategoryItem {
    pub id: String,
    pub custom_category_id: String,
    pub playlist_id: String,
    #[serde(rename = "type")]
    pub item_type: StreamType,
    pub upstream_stream_id: String,
    pub upstream_source_id: String,
    pub stream_id: String,
    #[serde(default)]
    pub extra: Option<serde_json::Value>,
}
