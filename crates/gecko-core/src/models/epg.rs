use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EpgSource {
    pub id: String,
    pub user_id: String,
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub extra: Option<serde_json::Value>,
}
