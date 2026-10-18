use crate::state::AppState;
use axum::{
    extract::{Extension, Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use gecko_core::crypto::JwtClaims;
use gecko_core::repo;
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
pub struct LogsQuery {
    #[serde(default = "default_logs_limit")]
    pub limit: usize,
}

fn default_logs_limit() -> usize {
    500
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IpInfoResponse {
    pub ip: String,
    pub country: String,
    pub city: String,
    pub org: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramTestPayload {
    pub bot_token: Option<String>,
    pub chat_id: Option<String>,
}

// =====================================
// System Routes Handlers
// =====================================

pub async fn handle_ip() -> Response {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap_or_default();

    match client.get("http://ipinfo.io/json").send().await {
        Ok(res) => {
            if let Ok(info) = res.json::<serde_json::Value>().await {
                let data = IpInfoResponse {
                    ip: info["ip"].as_str().unwrap_or("127.0.0.1").to_string(),
                    country: info["country"].as_str().unwrap_or("").to_string(),
                    city: info["city"].as_str().unwrap_or("").to_string(),
                    org: info["org"].as_str().unwrap_or("").to_string(),
                };
                return (StatusCode::OK, Json(data)).into_response();
            }
        }
        Err(e) => {
            tracing::warn!("Failed to fetch public IP: {}", e);
        }
    }

    (
        StatusCode::OK,
        Json(IpInfoResponse {
            ip: "127.0.0.1".to_string(),
            country: "Local".to_string(),
            city: "Local".to_string(),
            org: "GECKO Internal".to_string(),
        }),
    )
        .into_response()
}

pub async fn handle_vpn() -> Response {
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "configured": false,
            "connected": false,
            "provider": null,
            "city": null,
            "country": null,
            "publicIp": null
        })),
    )
        .into_response()
}

pub async fn handle_vpn_reconnect() -> Response {
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "success": false,
            "message": "VPN / Gluetun integration not configured"
        })),
    )
        .into_response()
}

pub async fn handle_logs(Query(q): Query<LogsQuery>) -> Response {
    let log_file = std::path::Path::new("gecko.log");
    if !log_file.exists() {
        return (
            StatusCode::OK,
            Json(serde_json::json!({ "logs": "", "totalLines": 0 })),
        )
            .into_response();
    }

    match tokio::fs::read_to_string(log_file).await {
        Ok(content) => {
            let lines: Vec<&str> = content.lines().collect();
            let total = lines.len();
            let start = total.saturating_sub(q.limit);
            let tail = lines[start..].join("\n");
            (
                StatusCode::OK,
                Json(serde_json::json!({ "logs": tail, "totalLines": total })),
            )
                .into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

pub async fn handle_proxy_stats(
    State(state): State<AppState>,
    Extension(_claims): Extension<JwtClaims>,
) -> Response {
    let (playlists_count, users_count) = {
        let conn = state.db.pool.get();
        match conn {
            Ok(c) => {
                let p_count: i64 = c
                    .query_row("SELECT count(*) FROM playlists", [], |r| r.get(0))
                    .unwrap_or(0);
                let u_count: i64 = c
                    .query_row("SELECT count(*) FROM users", [], |r| r.get(0))
                    .unwrap_or(0);
                (p_count, u_count)
            }
            Err(_) => (0, 0),
        }
    };

    let active_streams = state.hub.active_channels_count().await;

    let response = serde_json::json!({
        "activeStreams": active_streams,
        "totalBytes": 0,
        "currentBps": 0,
        "history": [],
        "totalPlaylists": playlists_count,
        "totalUsers": users_count,
        "directStreamsCount": 0,
        "connections": [],
        "cache": {
            "entries": 0,
            "bytes": 0,
            "size": "0 B",
            "ttlMs": 43200000
        },
        "monthBytes": 0,
        "monthlyQuotaBytes": 10737418240_u64
    });

    (StatusCode::OK, Json(response)).into_response()
}

pub async fn kill_stream(Path(id): Path<String>) -> Response {
    (StatusCode::OK, Json(serde_json::json!({ "ok": true, "id": id }))).into_response()
}

pub async fn kill_all_streams() -> Response {
    (StatusCode::OK, Json(serde_json::json!({ "ok": true, "killed": 0 }))).into_response()
}

// =====================================
// Settings Handlers
// =====================================

pub async fn get_settings(State(state): State<AppState>) -> Response {
    let setting = repo::settings::get_setting(&state.db.pool, "global").ok().flatten();
    let default_val = serde_json::json!({
        "qualityLabelFormat": "{surround::exists[\"[{surround}] \"||\"\"]}{hdr::exists[\"[{hdr}] \"||\"\"]}[{label}]",
        "telegramBotToken": "",
        "telegramChatId": "",
        "telegramEnabled": false,
        "telegramKeywords": [],
        "llmEnabled": false,
        "llmUrl": "",
        "llmApiKey": "",
        "llmModel": "",
        "llmSystemPrompt": "You are a media title formatting assistant.",
        "monthlyTrafficQuotaGB": 10240
    });

    let merged = match setting {
        Some(serde_json::Value::Object(map)) => {
            let mut def_map = match default_val {
                serde_json::Value::Object(m) => m,
                _ => serde_json::Map::new(),
            };
            for (k, v) in map {
                def_map.insert(k, v);
            }
            serde_json::Value::Object(def_map)
        }
        _ => default_val,
    };

    (StatusCode::OK, Json(merged)).into_response()
}

pub async fn update_settings(
    State(state): State<AppState>,
    Extension(claims): Extension<JwtClaims>,
    Json(payload): Json<serde_json::Value>,
) -> Response {
    if claims.role != "admin" {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({ "error": "Admin required" }))).into_response();
    }

    let current = repo::settings::get_setting(&state.db.pool, "global")
        .ok()
        .flatten()
        .unwrap_or(serde_json::json!({}));

    let mut map = match current {
        serde_json::Value::Object(m) => m,
        _ => serde_json::Map::new(),
    };

    if let serde_json::Value::Object(new_map) = payload {
        for (k, v) in new_map {
            map.insert(k, v);
        }
    }

    let final_val = serde_json::Value::Object(map);
    let final_clone = final_val.clone();

    match state.db.writer.write(move |conn| repo::settings::upsert_setting_sync(conn, "global", &final_clone)).await {
        Ok(_) => (StatusCode::OK, Json(serde_json::json!({ "success": true }))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e.to_string() }))).into_response(),
    }
}

pub async fn test_telegram(Json(_payload): Json<TelegramTestPayload>) -> Response {
    (StatusCode::OK, Json(serde_json::json!({ "success": true }))).into_response()
}

// =====================================
// Public Health & Version Handlers
// =====================================

pub async fn handle_health() -> Response {
    (StatusCode::OK, Json(serde_json::json!({ "status": "ok" }))).into_response()
}

pub async fn handle_version() -> Response {
    (StatusCode::OK, Json(serde_json::json!({ "version": "0.2.0" }))).into_response()
}
