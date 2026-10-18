use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Setting {
    pub id: String,
    #[serde(default)]
    pub extra: Option<serde_json::Value>,
}
