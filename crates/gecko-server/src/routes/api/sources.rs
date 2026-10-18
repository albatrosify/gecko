use crate::state::AppState;
use axum::{
    extract::{Extension, Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use gecko_core::crypto::JwtClaims;
use gecko_core::models::{Source, SourceExtra, SourceType};
use gecko_core::repo;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSourcePayload {
    pub name: String,
    #[serde(rename = "type")]
    pub source_type: String,
    pub url: String,
    pub username: Option<String>,
    pub password: Option<String>,
    #[serde(default)]
    pub auto_sync_enabled: bool,
    pub sync_cron: Option<String>,
    #[serde(flatten, default)]
    pub extra: SourceExtra,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSourcePayload {
    pub name: Option<String>,
    #[serde(rename = "type")]
    pub source_type: Option<String>,
    pub url: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub auto_sync_enabled: Option<bool>,
    pub sync_cron: Option<String>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

pub async fn list_sources(
    State(state): State<AppState>,
    Extension(claims): Extension<JwtClaims>,
) -> Response {
    match repo::sources::list_sources_by_user(&state.db.pool, &claims.sub) {
        Ok(sources) => (StatusCode::OK, Json(sources)).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

pub async fn create_source(
    State(state): State<AppState>,
    Extension(claims): Extension<JwtClaims>,
    Json(payload): Json<CreateSourcePayload>,
) -> Response {
    let source_type = SourceType::from_str_opt(&payload.source_type).unwrap_or(SourceType::Xtream);
    let source = Source {
        id: uuid::Uuid::new_v4().to_string(),
        user_id: claims.sub,
        name: payload.name,
        source_type,
        url: payload.url,
        username: payload.username,
        password: payload.password,
        auto_sync_enabled: payload.auto_sync_enabled,
        sync_cron: payload.sync_cron,
        extra: payload.extra,
    };

    let source_clone = source.clone();
    match state
        .db
        .writer
        .write(move |conn| repo::sources::insert_source_sync(conn, &source_clone))
        .await
    {
        Ok(_) => (StatusCode::CREATED, Json(source)).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

pub async fn get_source(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Response {
    match repo::sources::get_source_by_id(&state.db.pool, &id) {
        Ok(Some(source)) => (StatusCode::OK, Json(source)).into_response(),
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

pub async fn update_source(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(payload): Json<UpdateSourcePayload>,
) -> Response {
    let existing = match repo::sources::get_source_by_id(&state.db.pool, &id) {
        Ok(Some(s)) => s,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": e.to_string() })),
            )
                .into_response()
        }
    };

    let source_type = payload
        .source_type
        .as_deref()
        .and_then(SourceType::from_str_opt)
        .unwrap_or(existing.source_type);

    // Merge extra fields
    let mut extra_val = serde_json::to_value(&existing.extra).unwrap_or_else(|_| serde_json::json!({}));
    if let serde_json::Value::Object(ref mut map) = extra_val {
        for (k, v) in payload.extra {
            if k != "id" && k != "userId" && k != "name" && k != "type" && k != "url" && k != "username" && k != "password" && k != "autoSyncEnabled" && k != "syncCron" {
                map.insert(k, v);
            }
        }
    }
    let merged_extra: SourceExtra = serde_json::from_value(extra_val).unwrap_or(existing.extra);

    let updated = Source {
        id: id.clone(),
        user_id: existing.user_id,
        name: payload.name.unwrap_or(existing.name),
        source_type,
        url: payload.url.unwrap_or(existing.url),
        username: payload.username.or(existing.username),
        password: payload.password.or(existing.password),
        auto_sync_enabled: payload.auto_sync_enabled.unwrap_or(existing.auto_sync_enabled),
        sync_cron: payload.sync_cron.or(existing.sync_cron),
        extra: merged_extra,
    };

    let updated_clone = updated.clone();
    match state
        .db
        .writer
        .write(move |conn| repo::sources::update_source_sync(conn, &updated_clone))
        .await
    {
        Ok(_) => (StatusCode::OK, Json(updated)).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

pub async fn delete_source(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Response {
    match state
        .db
        .writer
        .write(move |conn| repo::sources::delete_source_sync(conn, &id))
        .await
    {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

pub async fn refresh_source(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Response {
    use gecko_core::xtream::XtreamClient;

    let mut source = match repo::sources::get_source_by_id(&state.db.pool, &id) {
        Ok(Some(s)) => s,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({ "error": "Source not found" })),
            )
                .into_response()
        }
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": e.to_string() })),
            )
                .into_response()
        }
    };

    let client = XtreamClient::new(
        &source.url,
        source.username.as_deref(),
        source.password.as_deref(),
    );

    // 1. Authenticate and update metadata
    let mut summary_live = "0 streams".to_string();
    let mut summary_vod = "0 movies".to_string();
    let mut summary_series = "0 series".to_string();

    match client.authenticate().await {
        Ok(auth) => {
            if let Some(exp) = auth.user_info.exp_date {
                source.extra.expiry_date = Some(exp);
            }
            if !auth.user_info.status.is_empty() {
                source.extra.account_status = Some(auth.user_info.status);
            }
            if let Some(max_c) = auth.user_info.max_connections {
                source.extra.max_connections = Some(serde_json::Value::String(max_c));
            }
        }
        Err(e) => {
            return (
                StatusCode::OK,
                Json(serde_json::json!({
                    "success": false,
                    "error": format!("Upstream authentication failed: {}", e),
                    "summary": {
                        "live": "Failed",
                        "vod": "Failed",
                        "series": "Failed"
                    },
                    "results": []
                })),
            )
                .into_response();
        }
    }

    // 2. Fetch live streams
    if let Ok(streams) = client.get_live_streams().await {
        summary_live = format!("{} streams", streams.len());
        if let Ok(streams_val) = serde_json::to_value(&streams) {
            let key = format!("source_{}_live_streams", id);
            let _ = state.db.writer.write(move |conn| {
                let expires_at = chrono::Utc::now().timestamp_millis() + 86_400_000;
                repo::cache::set_cache_sync(conn, &key, &streams_val, Some(expires_at))
            }).await;
        }
    }

    // 3. Fetch VOD streams
    if let Ok(vod) = client.get_vod_streams().await {
        summary_vod = format!("{} movies", vod.len());
        if let Ok(vod_val) = serde_json::to_value(&vod) {
            let key = format!("source_{}_vod_streams", id);
            let _ = state.db.writer.write(move |conn| {
                let expires_at = chrono::Utc::now().timestamp_millis() + 86_400_000;
                repo::cache::set_cache_sync(conn, &key, &vod_val, Some(expires_at))
            }).await;
        }
    }

    // 4. Fetch Series
    if let Ok(series) = client.get_series().await {
        summary_series = format!("{} series", series.len());
        if let Ok(series_val) = serde_json::to_value(&series) {
            let key = format!("source_{}_series", id);
            let _ = state.db.writer.write(move |conn| {
                let expires_at = chrono::Utc::now().timestamp_millis() + 86_400_000;
                repo::cache::set_cache_sync(conn, &key, &series_val, Some(expires_at))
            }).await;
        }
    }

    // Update lastUpdated
    source.extra.additional.insert(
        "lastUpdated".to_string(),
        serde_json::Value::String(chrono::Utc::now().to_rfc3339()),
    );

    let source_clone = source.clone();
    let _ = state
        .db
        .writer
        .write(move |conn| repo::sources::update_source_sync(conn, &source_clone))
        .await;

    (
        StatusCode::OK,
        Json(serde_json::json!({
            "success": true,
            "summary": {
                "live": summary_live,
                "vod": summary_vod,
                "series": summary_series
            },
            "results": []
        })),
    )
        .into_response()
}

pub async fn get_source_changelog(
    State(_state): State<AppState>,
    Path(_id): Path<String>,
) -> Response {
    (StatusCode::OK, Json(serde_json::json!([]))).into_response()
}

pub async fn get_source_connections(
    State(_state): State<AppState>,
    Path(_id): Path<String>,
) -> Response {
    (StatusCode::OK, Json(serde_json::json!([]))).into_response()
}

pub async fn check_source_connection(
    State(_state): State<AppState>,
    Path(_id): Path<String>,
) -> Response {
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "success": true,
            "log": {
                "status": "ok",
                "activeCons": 0,
                "maxCons": 1,
                "geckoStreams": 0,
                "isExternal": false
            }
        })),
    )
        .into_response()
}

pub async fn clear_source_connections(
    State(_state): State<AppState>,
    Path(_id): Path<String>,
) -> Response {
    (StatusCode::OK, Json(serde_json::json!({ "success": true }))).into_response()
}

pub async fn benchmark_source(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Response {
    match repo::sources::get_source_by_id(&state.db.pool, &id) {
        Ok(Some(source)) => {
            let hosts = source.extra.hosts.clone().unwrap_or_default();
            (
                StatusCode::OK,
                Json(serde_json::json!({
                    "success": true,
                    "hosts": hosts
                })),
            )
                .into_response()
        }
        Ok(None) => (StatusCode::NOT_FOUND, Json(serde_json::json!({ "error": "Source not found" }))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e.to_string() }))).into_response(),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchUpstreamPayload {
    pub source: SourceRef,
    pub source_index: Option<usize>,
    pub force_refresh: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct SourceRef {
    pub id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchStreamsPayload {
    pub source: SourceRef,
    pub r#type: String,
    pub source_index: Option<usize>,
    pub force_refresh: Option<bool>,
}

pub async fn fetch_upstream(
    State(state): State<AppState>,
    Json(payload): Json<FetchUpstreamPayload>,
) -> Response {
    let source = match repo::sources::get_source_by_id(&state.db.pool, &payload.source.id) {
        Ok(Some(s)) => s,
        Ok(None) => return (StatusCode::NOT_FOUND, Json(serde_json::json!({ "error": "Source not found" }))).into_response(),
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e.to_string() }))).into_response(),
    };

    let cache_key = format!("{}_categories", source.id);
    let force_refresh = payload.force_refresh.unwrap_or(false);

    let (mut live_cats, mut vod_cats, mut series_cats, cached, last_updated) = if !force_refresh {
        if let Ok(Some(cached_entry)) = repo::cache::get_cache(&state.db.pool, &cache_key) {
            if let Some(data) = cached_entry.data {
                let live: Vec<serde_json::Value> = serde_json::from_value(data.get("liveCats").cloned().unwrap_or(serde_json::Value::Array(vec![]))).unwrap_or_default();
                let vod: Vec<serde_json::Value> = serde_json::from_value(data.get("vodCats").cloned().unwrap_or(serde_json::Value::Array(vec![]))).unwrap_or_default();
                let series: Vec<serde_json::Value> = serde_json::from_value(data.get("seriesCats").cloned().unwrap_or(serde_json::Value::Array(vec![]))).unwrap_or_default();
                (live, vod, series, true, cached_entry.updated_at.unwrap_or_else(|| chrono::Utc::now().to_rfc3339()))
            } else {
                fetch_fresh_categories(&state, &source, &cache_key).await
            }
        } else {
            fetch_fresh_categories(&state, &source, &cache_key).await
        }
    } else {
        fetch_fresh_categories(&state, &source, &cache_key).await
    };

    if let Some(idx) = payload.source_index {
        for c in &mut live_cats {
            if let Some(obj) = c.as_object_mut() { obj.insert("_sourceIdx".to_string(), serde_json::json!(idx)); }
        }
        for c in &mut vod_cats {
            if let Some(obj) = c.as_object_mut() { obj.insert("_sourceIdx".to_string(), serde_json::json!(idx)); }
        }
        for c in &mut series_cats {
            if let Some(obj) = c.as_object_mut() { obj.insert("_sourceIdx".to_string(), serde_json::json!(idx)); }
        }
    }

    (StatusCode::OK, Json(serde_json::json!({
        "liveCats": live_cats,
        "vodCats": vod_cats,
        "seriesCats": series_cats,
        "cached": cached,
        "lastUpdated": last_updated
    }))).into_response()
}

async fn fetch_fresh_categories(
    state: &AppState,
    source: &gecko_core::models::Source,
    cache_key: &str,
) -> (Vec<serde_json::Value>, Vec<serde_json::Value>, Vec<serde_json::Value>, bool, String) {
    use gecko_core::xtream::XtreamClient;
    let client = XtreamClient::new(&source.url, source.username.as_deref(), source.password.as_deref());
    let live_cats = client.get_live_categories().await.unwrap_or_default();
    let vod_cats = client.get_vod_categories().await.unwrap_or_default();
    let series_cats = client.get_series_categories().await.unwrap_or_default();

    let live_val = serde_json::to_value(&live_cats).unwrap_or(serde_json::Value::Array(vec![]));
    let vod_val = serde_json::to_value(&vod_cats).unwrap_or(serde_json::Value::Array(vec![]));
    let series_val = serde_json::to_value(&series_cats).unwrap_or(serde_json::Value::Array(vec![]));

    let cache_val = serde_json::json!({
        "liveCats": live_val,
        "vodCats": vod_val,
        "seriesCats": series_val
    });

    let k = cache_key.to_string();
    let v = cache_val.clone();
    let _ = state.db.writer.write(move |conn| {
        repo::cache::set_cache_sync(conn, &k, &v, None)
    }).await;

    let now = chrono::Utc::now().to_rfc3339();
    let l_vec: Vec<serde_json::Value> = serde_json::from_value(live_val).unwrap_or_default();
    let v_vec: Vec<serde_json::Value> = serde_json::from_value(vod_val).unwrap_or_default();
    let s_vec: Vec<serde_json::Value> = serde_json::from_value(series_val).unwrap_or_default();
    (l_vec, v_vec, s_vec, false, now)
}

pub async fn fetch_streams(
    State(state): State<AppState>,
    Json(payload): Json<FetchStreamsPayload>,
) -> Response {
    let source = match repo::sources::get_source_by_id(&state.db.pool, &payload.source.id) {
        Ok(Some(s)) => s,
        Ok(None) => return (StatusCode::NOT_FOUND, Json(serde_json::json!({ "error": "Source not found" }))).into_response(),
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e.to_string() }))).into_response(),
    };

    let cache_key = format!("{}_streams_{}", source.id, payload.r#type);
    let force_refresh = payload.force_refresh.unwrap_or(false);

    let (mut streams, cached, last_updated) = if !force_refresh {
        if let Ok(Some(cached_entry)) = repo::cache::get_cache(&state.db.pool, &cache_key) {
            if let Some(data) = cached_entry.data {
                let st: Vec<serde_json::Value> = serde_json::from_value(data).unwrap_or_default();
                (st, true, cached_entry.updated_at.unwrap_or_else(|| chrono::Utc::now().to_rfc3339()))
            } else {
                fetch_fresh_streams(&state, &source, &payload.r#type, &cache_key).await
            }
        } else {
            fetch_fresh_streams(&state, &source, &payload.r#type, &cache_key).await
        }
    } else {
        fetch_fresh_streams(&state, &source, &payload.r#type, &cache_key).await
    };

    if let Some(idx) = payload.source_index {
        for s in &mut streams {
            if let Some(obj) = s.as_object_mut() { obj.insert("_sourceIdx".to_string(), serde_json::json!(idx)); }
        }
    }

    (StatusCode::OK, Json(serde_json::json!({
        "streams": streams,
        "cached": cached,
        "lastUpdated": last_updated
    }))).into_response()
}

async fn fetch_fresh_streams(
    state: &AppState,
    source: &gecko_core::models::Source,
    stream_type: &str,
    cache_key: &str,
) -> (Vec<serde_json::Value>, bool, String) {
    use gecko_core::xtream::XtreamClient;
    let client = XtreamClient::new(&source.url, source.username.as_deref(), source.password.as_deref());
    let streams_val = match stream_type {
        "live" => serde_json::to_value(&client.get_live_streams().await.unwrap_or_default()).unwrap_or(serde_json::Value::Array(vec![])),
        "vod" => serde_json::to_value(&client.get_vod_streams().await.unwrap_or_default()).unwrap_or(serde_json::Value::Array(vec![])),
        "series" => serde_json::to_value(&client.get_series().await.unwrap_or_default()).unwrap_or(serde_json::Value::Array(vec![])),
        _ => serde_json::Value::Array(vec![]),
    };

    let k = cache_key.to_string();
    let v = streams_val.clone();
    let _ = state.db.writer.write(move |conn| {
        repo::cache::set_cache_sync(conn, &k, &v, None)
    }).await;

    let now = chrono::Utc::now().to_rfc3339();
    let st: Vec<serde_json::Value> = serde_json::from_value(streams_val).unwrap_or_default();
    (st, false, now)
}

