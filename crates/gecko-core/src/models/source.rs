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
pub struct SourceHostResolvedIp {
    pub ip: String,
    #[serde(rename = "latencyMs", default)]
    pub latency_ms: Option<f64>,
    #[serde(default = "default_true")]
    pub healthy: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SourceHost {
    pub url: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub order: i32,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(rename = "latencyMs", default)]
    pub latency_ms: Option<f64>,
    #[serde(rename = "authOk", default)]
    pub auth_ok: Option<bool>,
    #[serde(rename = "throughputMbps", default)]
    pub throughput_mbps: Option<f64>,
    #[serde(rename = "probeOk", default)]
    pub probe_ok: Option<bool>,
    #[serde(rename = "networkType", default)]
    pub network_type: Option<String>,
    #[serde(rename = "cdnProvider", default)]
    pub cdn_provider: Option<String>,
    #[serde(rename = "resolvedIp", default)]
    pub resolved_ip: Option<String>,
    #[serde(rename = "resolvedIps", default)]
    pub resolved_ips: Option<Vec<SourceHostResolvedIp>>,
    #[serde(rename = "ipCount", default)]
    pub ip_count: Option<usize>,
    #[serde(rename = "lastBenchmark", default)]
    pub last_benchmark: Option<String>,
    #[serde(default)]
    pub uses: u64,
    #[serde(default)]
    pub failures: u64,
    #[serde(rename = "lastUsed", default)]
    pub last_used: Option<String>,
    #[serde(rename = "lastError", default)]
    pub last_error: Option<String>,
    #[serde(rename = "vpnBlocked", default)]
    pub vpn_blocked: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SourceExtra {
    #[serde(rename = "useUpstreamEpg", default)]
    pub use_upstream_epg: Option<bool>,
    #[serde(rename = "expiryDate", default)]
    pub expiry_date: Option<String>,
    #[serde(rename = "accountStatus", default)]
    pub account_status: Option<String>,
    #[serde(rename = "maxConnections", default)]
    pub max_connections: Option<serde_json::Value>,
    #[serde(rename = "monitorEnabled", default)]
    pub monitor_enabled: Option<bool>,
    #[serde(rename = "monitorInterval", default)]
    pub monitor_interval: Option<u64>,
    #[serde(rename = "lastMonitorCheck", default)]
    pub last_monitor_check: Option<String>,
    #[serde(rename = "lastActiveCons", default)]
    pub last_active_cons: Option<u32>,
    #[serde(rename = "lastMaxCons", default)]
    pub last_max_cons: Option<u32>,
    #[serde(rename = "lastMonitorStatus", default)]
    pub last_monitor_status: Option<String>,
    #[serde(rename = "lastMonitorError", default)]
    pub last_monitor_error: Option<String>,
    #[serde(rename = "benchmarkStreamId", default)]
    pub benchmark_stream_id: Option<serde_json::Value>,
    #[serde(rename = "benchmarkStreamName", default)]
    pub benchmark_stream_name: Option<String>,
    #[serde(default)]
    pub hosts: Option<Vec<SourceHost>>,
    #[serde(rename = "concurrencyGuard", default)]
    pub concurrency_guard: Option<bool>,
    #[serde(flatten)]
    pub additional: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    pub extra: SourceExtra,
}
