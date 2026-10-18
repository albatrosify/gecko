use crate::state::AppState;
use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use gecko_core::models::{
    recording_id_to_numeric, CategoryMapping, Playlist, RecordingStatus, StreamMapping, StreamType,
};
use gecko_core::repo;
use gecko_core::xtream::{XtreamCategory, XtreamClient, XtreamLiveStream, XtreamVodStream};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tracing::{error, warn};

pub const DVR_CATEGORY_ID: &str = "999999";

#[derive(Debug, Deserialize)]
pub struct PlayerApiQuery {
    pub username: Option<String>,
    pub password: Option<String>,
    pub u: Option<String>,
    pub p: Option<String>,
    pub action: Option<String>,
    pub category_id: Option<String>,
    pub stream_id: Option<String>,
    pub series_id: Option<String>,
    pub vod_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ApiErrorResponse {
    pub status: &'static str,
    pub message: String,
}

pub async fn handle_player_api(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<PlayerApiQuery>,
) -> Response {
    let username = query.username.or(query.u);
    let password = query.password.or(query.p);

    let (user, pass) = match (username, password) {
        (Some(u), Some(p)) if !u.is_empty() && !p.is_empty() => (u, p),
        _ => {
            return (
                StatusCode::OK,
                Json(ApiErrorResponse {
                    status: "error",
                    message: "Missing credentials".to_string(),
                }),
            )
                .into_response();
        }
    };

    // Authenticate credentials against database playlists
    let playlist = match repo::playlists::get_playlist_by_credentials(&state.db.pool, &user, &pass)
    {
        Ok(Some(p)) => p,
        Ok(None) => {
            return (
                StatusCode::OK,
                Json(ApiErrorResponse {
                    status: "error",
                    message: "Invalid credentials".to_string(),
                }),
            )
                .into_response();
        }
        Err(e) => {
            error!("Database error fetching playlist: {}", e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    let source_id = match playlist.source_ids.first() {
        Some(s) => s.clone(),
        None => {
            return (
                StatusCode::OK,
                Json(ApiErrorResponse {
                    status: "error",
                    message: "No source configured for this playlist".to_string(),
                }),
            )
                .into_response();
        }
    };

    let source = match repo::sources::get_source_by_id(&state.db.pool, &source_id) {
        Ok(Some(s)) => s,
        _ => {
            return (
                StatusCode::OK,
                Json(ApiErrorResponse {
                    status: "error",
                    message: "Source not found".to_string(),
                }),
            )
                .into_response();
        }
    };

    let client = XtreamClient::new(
        &source.url,
        source.username.as_deref(),
        source.password.as_deref(),
    );

    match query.action.as_deref() {
        None => handle_authenticate(&playlist, &client, &headers).await,
        Some("get_live_categories") => {
            handle_get_live_categories(&state, &playlist, &client).await
        }
        Some("get_live_streams") => {
            handle_get_live_streams(&state, &playlist, &client, query.category_id.as_deref()).await
        }
        Some("get_vod_categories") => {
            handle_get_vod_categories(&state, &playlist, &client).await
        }
        Some("get_vod_streams") => {
            handle_get_vod_streams(&state, &playlist, &client, query.category_id.as_deref()).await
        }
        Some("get_series_categories") => handle_get_series_categories(&client).await,
        Some("get_series") => handle_get_series(&client).await,
        Some("get_series_info") => {
            let sid: u32 = query
                .series_id
                .and_then(|s| s.parse().ok())
                .unwrap_or_default();
            handle_get_series_info(&client, sid).await
        }
        Some("get_vod_info") => {
            let vid_str = query.vod_id.unwrap_or_default();
            handle_get_vod_info(&state, &client, &vid_str).await
        }
        Some("get_live_info") => {
            let sid: u32 = query
                .stream_id
                .and_then(|s| s.parse().ok())
                .unwrap_or_default();
            handle_get_live_info(&client, sid).await
        }
        Some(unknown) => {
            warn!("Unhandled player_api action: {}", unknown);
            (StatusCode::OK, Json(serde_json::json!([]))).into_response()
        }
    }
}

async fn handle_authenticate(
    playlist: &Playlist,
    client: &XtreamClient,
    headers: &HeaderMap,
) -> Response {
    match client.authenticate().await {
        Ok(mut auth) => {
            auth.user_info.username = playlist.username.clone();
            auth.user_info.password = playlist.password.clone();

            if let Some(host_val) = headers.get("host").and_then(|h| h.to_str().ok()) {
                auth.server_info.url = format!("http://{}", host_val);
                if let Some((_, port)) = host_val.split_once(':') {
                    auth.server_info.port = port.to_string();
                } else {
                    auth.server_info.port = "80".to_string();
                }
            }

            (StatusCode::OK, Json(auth)).into_response()
        }
        Err(e) => {
            error!("Upstream authenticate failed: {}", e);
            (
                StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({
                    "user_info": {
                        "auth": 0,
                        "status": "Disabled",
                        "message": format!("Upstream error: {}", e)
                    }
                })),
            )
                .into_response()
        }
    }
}

async fn handle_get_live_categories(
    state: &AppState,
    playlist: &Playlist,
    client: &XtreamClient,
) -> Response {
    let mut categories = client.get_live_categories().await.unwrap_or_default();

    // Append custom categories
    if let Ok(custom_cats) = repo::custom_categories::get_custom_categories_by_playlist_and_type(
        &state.db.pool,
        &playlist.id,
        StreamType::Live,
    ) {
        for cc in custom_cats {
            if !cc.hidden {
                categories.push(XtreamCategory {
                    category_id: format!("custom_{}", cc.id),
                    category_name: cc.name,
                    parent_id: Some(0),
                });
            }
        }
    }

    // Apply category overrides
    if let Ok(mappings) = repo::mappings::get_category_mappings_by_playlist_and_type(
        &state.db.pool,
        &playlist.id,
        StreamType::Live,
    ) {
        let map: HashMap<String, CategoryMapping> = mappings
            .into_iter()
            .map(|m| (m.original_id.clone(), m))
            .collect();

        categories.retain_mut(|c| {
            if let Some(m) = map.get(&c.category_id) {
                if m.extra.hidden {
                    return false;
                }
                if let Some(custom_name) = &m.extra.custom_name {
                    c.category_name = custom_name.clone();
                }
            }
            true
        });
    }

    (StatusCode::OK, Json(categories)).into_response()
}

async fn handle_get_live_streams(
    state: &AppState,
    playlist: &Playlist,
    client: &XtreamClient,
    category_id_filter: Option<&str>,
) -> Response {
    let mut streams = client.get_live_streams().await.unwrap_or_default();

    // Append custom category item clones (symlinks)
    if let Ok(custom_items) =
        repo::custom_categories::get_custom_category_items_by_playlist_and_type(
            &state.db.pool,
            &playlist.id,
            StreamType::Live,
        )
    {
        for item in custom_items {
            let user_stream_id: u32 = item.stream_id.parse().unwrap_or(0);
            let mut clone = XtreamLiveStream::default();
            clone.stream_id = user_stream_id;
            clone.category_id = item.custom_category_id;
            clone.stream_type = "live".to_string();

            if let Some(extra) = &item.extra {
                if let Some(name) = extra.get("name").and_then(|v| v.as_str()) {
                    clone.name = name.to_string();
                }
                if let Some(icon) = extra.get("stream_icon").and_then(|v| v.as_str()) {
                    clone.stream_icon = Some(icon.to_string());
                }
            }
            streams.push(clone);
        }
    }

    // Apply stream mappings (name, icon, hidden, category override)
    if let Ok(mappings) = repo::mappings::get_mappings_by_playlist_and_type(
        &state.db.pool,
        &playlist.id,
        StreamType::Live,
    ) {
        let map: HashMap<String, StreamMapping> = mappings
            .into_iter()
            .map(|m| (m.original_id.clone(), m))
            .collect();

        streams.retain_mut(|s| {
            let orig_id = s.stream_id.to_string();
            if let Some(m) = map.get(&orig_id) {
                if m.extra.hidden {
                    return false;
                }
                if let Some(custom_name) = &m.extra.custom_name {
                    s.name = custom_name.clone();
                }
                if let Some(custom_icon) = &m.extra.custom_icon {
                    s.stream_icon = Some(custom_icon.clone());
                }
                if let Some(cat_override) = &m.extra.category_id {
                    s.category_id = cat_override.clone();
                }
            }
            true
        });
    }

    // Filter by category_id if requested
    if let Some(filter_cat) = category_id_filter {
        streams.retain(|s| s.category_id == filter_cat);
    }

    (StatusCode::OK, Json(streams)).into_response()
}

async fn handle_get_vod_categories(
    _state: &AppState,
    _playlist: &Playlist,
    client: &XtreamClient,
) -> Response {
    let mut categories = client.get_vod_categories().await.unwrap_or_default();

    // Append DVR Recordings category with numeric ID for Televizo/Android IPTV compatibility
    categories.push(XtreamCategory {
        category_id: DVR_CATEGORY_ID.to_string(),
        category_name: "DVR Recordings".to_string(),
        parent_id: Some(0),
    });

    (StatusCode::OK, Json(categories)).into_response()
}

async fn handle_get_vod_streams(
    state: &AppState,
    _playlist: &Playlist,
    client: &XtreamClient,
    category_id_filter: Option<&str>,
) -> Response {
    let mut streams = client.get_vod_streams().await.unwrap_or_default();

    // Include completed DVR recordings as VOD entries with deterministic numeric IDs
    if let Ok(recordings) = repo::recordings::list_all_recordings(&state.db.pool) {
        for r in recordings {
            if r.status == RecordingStatus::Completed {
                let numeric_id = recording_id_to_numeric(&r.id);
                let mut vod = XtreamVodStream::default();
                vod.stream_id = numeric_id;
                vod.name = r.stream_name.clone();
                vod.category_id = DVR_CATEGORY_ID.to_string();
                vod.container_extension = Some("ts".to_string());
                vod.added = Some(r.start_time.clone());

                streams.push(vod);
            }
        }
    }

    if let Some(filter_cat) = category_id_filter {
        streams.retain(|s| s.category_id == filter_cat);
    }

    (StatusCode::OK, Json(streams)).into_response()
}

async fn handle_get_series_categories(client: &XtreamClient) -> Response {
    let categories = client.get_series_categories().await.unwrap_or_default();
    (StatusCode::OK, Json(categories)).into_response()
}

async fn handle_get_series(client: &XtreamClient) -> Response {
    let series = client.get_series().await.unwrap_or_default();
    (StatusCode::OK, Json(series)).into_response()
}

async fn handle_get_series_info(client: &XtreamClient, series_id: u32) -> Response {
    match client.get_series_info(series_id).await {
        Ok(info) => (StatusCode::OK, Json(info)).into_response(),
        Err(_) => (StatusCode::OK, Json(serde_json::json!({}))).into_response(),
    }
}

async fn handle_get_vod_info(
    state: &AppState,
    client: &XtreamClient,
    vod_id_str: &str,
) -> Response {
    if let Ok(numeric_id) = vod_id_str.parse::<u32>() {
        if numeric_id >= 900_000_000 && numeric_id <= 999_999_999 {
            // It's a DVR recording!
            if let Ok(Some(rec)) = repo::recordings::get_recording_by_numeric_id(&state.db.pool, numeric_id) {
                let info = serde_json::json!({
                    "info": {
                        "name": rec.stream_name,
                        "duration_secs": rec.duration_seconds,
                        "duration": format!("{}s", rec.duration_seconds),
                        "bitrate": 0,
                        "releasedate": rec.start_time,
                    },
                    "movie_data": {
                        "stream_id": numeric_id,
                        "name": rec.stream_name,
                        "container_extension": "ts",
                        "category_id": DVR_CATEGORY_ID
                    }
                });
                return (StatusCode::OK, Json(info)).into_response();
            }
        }
    }

    let vod_id: u32 = vod_id_str.parse().unwrap_or(0);
    match client.get_vod_info(vod_id).await {
        Ok(info) => (StatusCode::OK, Json(info)).into_response(),
        Err(_) => (StatusCode::OK, Json(serde_json::json!({}))).into_response(),
    }
}

async fn handle_get_live_info(client: &XtreamClient, stream_id: u32) -> Response {
    match client.get_live_info(stream_id).await {
        Ok(info) => (StatusCode::OK, Json(info)).into_response(),
        Err(_) => (StatusCode::OK, Json(serde_json::json!({}))).into_response(),
    }
}
