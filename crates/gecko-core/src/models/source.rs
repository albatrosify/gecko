use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceType {
    Xtream,
    M3u,
}

impl SourceType {
    pub fn as_str(&self) -> &'static str {
        match self {
            SourceType::Xtream => "xtream",
            SourceType::M3u => "m3u",
        }
    }

    pub fn from_str_opt(s: &str) -> Option<Self> {
        match s.to_ascii_lowercase().as_str() {
            "xtream" => Some(SourceType::Xtream),
            "m3u" => Some(SourceType::M3u),
            _ => None,
        }
    }
}

impl std::fmt::Display for SourceType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SourceHostResolvedIp {
    pub ip: String,
    #[serde(default)]
    pub latency_ms: Option<f64>,
    #[serde(default = "default_true")]
    pub healthy: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SourceHost {
    pub url: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub order: i32,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub latency_ms: Option<f64>,
    #[serde(default)]
    pub auth_ok: Option<bool>,
    #[serde(default)]
    pub throughput_mbps: Option<f64>,
    #[serde(default)]
    pub probe_ok: Option<bool>,
    #[serde(default)]
    pub network_type: Option<String>,
    #[serde(default)]
    pub cdn_provider: Option<String>,
    #[serde(default)]
    pub resolved_ip: Option<String>,
    #[serde(default)]
    pub resolved_ips: Option<Vec<SourceHostResolvedIp>>,
    #[serde(default)]
    pub ip_count: Option<usize>,
    #[serde(default)]
    pub last_benchmark: Option<String>,
    #[serde(default)]
    pub uses: u64,
    #[serde(default)]
    pub failures: u64,
    #[serde(default)]
    pub last_used: Option<String>,
    #[serde(default)]
    pub last_error: Option<String>,
    #[serde(default)]
    pub vpn_blocked: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceExtra {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub use_upstream_epg: Option<bool>,
    #[serde(default)]
    pub expiry_date: Option<String>,
    #[serde(default)]
    pub account_status: Option<String>,
    #[serde(default)]
    pub max_connections: Option<serde_json::Value>,
    #[serde(default)]
    pub monitor_enabled: Option<bool>,
    #[serde(default)]
    pub monitor_interval: Option<u64>,
    #[serde(default)]
    pub last_monitor_check: Option<String>,
    #[serde(default)]
    pub last_active_cons: Option<u32>,
    #[serde(default)]
    pub last_max_cons: Option<u32>,
    #[serde(default)]
    pub last_monitor_status: Option<String>,
    #[serde(default)]
    pub last_monitor_error: Option<String>,
    #[serde(default)]
    pub benchmark_stream_id: Option<serde_json::Value>,
    #[serde(default)]
    pub benchmark_stream_name: Option<String>,
    #[serde(default)]
    pub hosts: Option<Vec<SourceHost>>,
    #[serde(default)]
    pub concurrency_guard: Option<bool>,
    #[serde(flatten)]
    pub additional: serde_json::Map<String, serde_json::Value>,
}

impl Default for SourceExtra {
    fn default() -> Self {
        Self {
            enabled: true,
            use_upstream_epg: None,
            expiry_date: None,
            account_status: None,
            max_connections: None,
            monitor_enabled: None,
            monitor_interval: None,
            last_monitor_check: None,
            last_active_cons: None,
            last_max_cons: None,
            last_monitor_status: None,
            last_monitor_error: None,
            benchmark_stream_id: None,
            benchmark_stream_name: None,
            hosts: None,
            concurrency_guard: None,
            additional: serde_json::Map::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub id: String,
    pub user_id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub source_type: SourceType,
    pub url: String,
    pub username: Option<String>,
    pub password: Option<String>,
    pub auto_sync_enabled: bool,
    pub sync_cron: Option<String>,
    #[serde(flatten, default)]
    pub extra: SourceExtra,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_source_json_camel_case_and_flatten() {
        let s = Source {
            id: "s1".into(),
            user_id: "u1".into(),
            name: "Test Source".into(),
            source_type: SourceType::Xtream,
            url: "http://example.com".into(),
            username: Some("user".into()),
            password: Some("pass".into()),
            auto_sync_enabled: true,
            sync_cron: Some("0 * * * *".into()),
            extra: SourceExtra {
                enabled: true,
                use_upstream_epg: Some(true),
                expiry_date: Some("2026-12-31".into()),
                ..Default::default()
            },
        };

        let val = serde_json::to_value(&s).unwrap();
        assert_eq!(val["id"], "s1");
        assert_eq!(val["userId"], "u1");
        assert_eq!(val["type"], "xtream");
        assert_eq!(val["autoSyncEnabled"], true);
        assert_eq!(val["syncCron"], "0 * * * *");
        assert_eq!(val["useUpstreamEpg"], true);
        assert_eq!(val["expiryDate"], "2026-12-31");
        assert_eq!(val["enabled"], true);
    }
}
