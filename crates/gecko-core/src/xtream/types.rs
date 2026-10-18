use serde::{Deserialize, Deserializer, Serialize};

pub fn deserialize_flexible_string<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    match value {
        serde_json::Value::String(s) => Ok(s),
        serde_json::Value::Number(n) => Ok(n.to_string()),
        serde_json::Value::Bool(b) => Ok(b.to_string()),
        serde_json::Value::Null => Ok(String::new()),
        _ => Ok(value.to_string()),
    }
}

pub fn deserialize_flexible_u32<'de, D>(deserializer: D) -> Result<u32, D::Error>
where
    D: Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    match value {
        serde_json::Value::Number(n) => Ok(n.as_u64().unwrap_or(0) as u32),
        serde_json::Value::String(s) => Ok(s.parse::<u32>().unwrap_or(0)),
        _ => Ok(0),
    }
}

pub fn deserialize_flexible_opt_u32<'de, D>(deserializer: D) -> Result<Option<u32>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    match value {
        serde_json::Value::Number(n) => Ok(n.as_u64().map(|v| v as u32)),
        serde_json::Value::String(s) => Ok(s.parse::<u32>().ok()),
        serde_json::Value::Null => Ok(None),
        _ => Ok(None),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct XtreamUserInfo {
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub exp_date: Option<String>,
    #[serde(default)]
    pub is_trial: Option<String>,
    #[serde(default)]
    pub active_cons: Option<String>,
    #[serde(default)]
    pub max_connections: Option<String>,
    #[serde(default)]
    pub auth: Option<u32>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct XtreamServerInfo {
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub port: String,
    #[serde(default)]
    pub https_port: Option<String>,
    #[serde(default)]
    pub server_protocol: Option<String>,
    #[serde(default)]
    pub timezone: Option<String>,
    #[serde(default)]
    pub timestamp_now: Option<u64>,
    #[serde(default)]
    pub time_now: Option<String>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct XtreamAuthResponse {
    #[serde(default)]
    pub user_info: XtreamUserInfo,
    #[serde(default)]
    pub server_info: XtreamServerInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct XtreamCategory {
    #[serde(deserialize_with = "deserialize_flexible_string")]
    pub category_id: String,
    #[serde(default)]
    pub category_name: String,
    #[serde(default)]
    pub parent_id: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct XtreamLiveStream {
    #[serde(default, deserialize_with = "deserialize_flexible_u32")]
    pub num: u32,
    #[serde(default)]
    pub name: String,
    #[serde(deserialize_with = "deserialize_flexible_string")]
    pub stream_type: String,
    #[serde(deserialize_with = "deserialize_flexible_u32")]
    pub stream_id: u32,
    #[serde(default)]
    pub stream_icon: Option<String>,
    #[serde(default)]
    pub epg_channel_id: Option<String>,
    #[serde(default)]
    pub added: Option<String>,
    #[serde(deserialize_with = "deserialize_flexible_string")]
    pub category_id: String,
    #[serde(default)]
    pub custom_sid: Option<String>,
    #[serde(default)]
    pub tv_archive: Option<u32>,
    #[serde(default)]
    pub direct_source: Option<String>,
    #[serde(default)]
    pub tv_archive_duration: Option<u32>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct XtreamVodStream {
    #[serde(default, deserialize_with = "deserialize_flexible_u32")]
    pub num: u32,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub stream_type: Option<String>,
    #[serde(deserialize_with = "deserialize_flexible_u32")]
    pub stream_id: u32,
    #[serde(default)]
    pub stream_icon: Option<String>,
    #[serde(default)]
    pub rating: Option<serde_json::Value>,
    #[serde(default)]
    pub rating_5based: Option<f64>,
    #[serde(default)]
    pub added: Option<String>,
    #[serde(deserialize_with = "deserialize_flexible_string")]
    pub category_id: String,
    #[serde(default)]
    pub container_extension: Option<String>,
    #[serde(default)]
    pub custom_sid: Option<String>,
    #[serde(default)]
    pub direct_source: Option<String>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct XtreamSeries {
    #[serde(default, deserialize_with = "deserialize_flexible_u32")]
    pub num: u32,
    #[serde(default)]
    pub name: String,
    #[serde(default, deserialize_with = "deserialize_flexible_u32")]
    pub series_id: u32,
    #[serde(default)]
    pub cover: Option<String>,
    #[serde(default)]
    pub plot: Option<String>,
    #[serde(default)]
    pub cast: Option<String>,
    #[serde(default)]
    pub director: Option<String>,
    #[serde(default)]
    pub genre: Option<String>,
    #[serde(default)]
    pub release_date: Option<String>,
    #[serde(default)]
    pub last_modified: Option<String>,
    #[serde(default)]
    pub rating: Option<serde_json::Value>,
    #[serde(default)]
    pub rating_5based: Option<f64>,
    #[serde(deserialize_with = "deserialize_flexible_string")]
    pub category_id: String,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}
