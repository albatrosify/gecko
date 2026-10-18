use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheEntry {
    pub key: String,
    #[serde(default)]
    pub data: Option<serde_json::Value>,
    #[serde(rename = "updatedAt", default)]
    pub updated_at: Option<String>,
    #[serde(rename = "expiresAt", default)]
    pub expires_at: Option<i64>,
}
