use crate::state::AppState;
use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use bytes::Bytes;
use futures_util::StreamExt;
use gecko_core::repo;
use gecko_proxy::guard::GuardDecision;
use tokio_util::io::ReaderStream;
use tracing::{error, warn};

pub async fn handle_live_stream(
    State(state): State<AppState>,
    Path((username, password, stream_param)): Path<(String, String, String)>,
) -> Response {
    let stream_id = stream_param
        .split('.')
        .next()
        .unwrap_or(&stream_param)
        .to_string();

    let playlist = match repo::playlists::get_playlist_by_credentials(&state.db.pool, &username, &password) {
        Ok(Some(p)) => p,
        _ => return StatusCode::UNAUTHORIZED.into_response(),
    };

    let source_id = match playlist.source_ids.first() {
        Some(s) => s.clone(),
        None => return (StatusCode::BAD_REQUEST, "No source configured for playlist").into_response(),
    };

    let source = match repo::sources::get_source_by_id(&state.db.pool, &source_id) {
        Ok(Some(s)) => s,
        _ => return (StatusCode::BAD_REQUEST, "Source not found").into_response(),
    };

    let user_name = source.username.as_deref().unwrap_or("");
    let pass_word = source.password.as_deref().unwrap_or("");
    let upstream_url = format!("{}/live/{}/{}/{}.ts", source.url.trim_end_matches('/'), user_name, pass_word, stream_id);

    let max_cons = source
        .extra
        .max_connections
        .as_ref()
        .and_then(|v| v.as_u64())
        .unwrap_or(1) as u32;

    let guard_enabled = source.extra.concurrency_guard.unwrap_or(false);

    // Evaluate concurrency guard
    let decision = state.guard.evaluate(&source_id, &stream_id, max_cons, guard_enabled).await;
    match decision {
        GuardDecision::BlockConflict { .. } => {
            warn!("Concurrency guard blocked conflicting stream {} for source {}", stream_id, source_id);
            return (StatusCode::CONFLICT, "Concurrent stream limit reached").into_response();
        }
        _ => {}
    }

    state.guard.register_stream(&source_id, &stream_id).await;

    // Resolve preferred IP from ranked host cache if available
    let preferred_ip = source
        .extra
        .hosts
        .as_ref()
        .and_then(|hosts| hosts.first())
        .and_then(|h| h.resolved_ip.as_ref())
        .and_then(|ip_str| ip_str.parse().ok());

    let channel_key = format!("{}_{}", source_id, stream_id);
    let rx = state.hub.subscribe(&channel_key, &upstream_url, preferred_ip).await;

    // Convert broadcast receiver to an HTTP streaming body
    let stream = tokio_stream::wrappers::BroadcastStream::new(rx).filter_map(|res| async {
        match res {
            Ok(bytes) => Some(Ok::<Bytes, std::io::Error>(bytes)),
            Err(tokio_stream::wrappers::errors::BroadcastStreamRecvError::Lagged(skipped)) => {
                warn!("Downstream subscriber lagged, skipped {} packets", skipped);
                None
            }
        }
    });

    let body = Body::from_stream(stream);

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "video/mp2t")
        .header(header::CACHE_CONTROL, "no-cache, no-store, must-revalidate")
        .header(header::CONNECTION, "keep-alive")
        .body(body)
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

pub async fn handle_movie_stream(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((username, password, stream_param)): Path<(String, String, String)>,
) -> Response {
    let stream_id = stream_param
        .split('.')
        .next()
        .unwrap_or(&stream_param)
        .to_string();

    let playlist = match repo::playlists::get_playlist_by_credentials(&state.db.pool, &username, &password) {
        Ok(Some(p)) => p,
        _ => return StatusCode::UNAUTHORIZED.into_response(),
    };

    // Check if it's a DVR recording numeric ID (900_000_000..999_999_999)
    if let Ok(numeric_id) = stream_id.parse::<u32>() {
        if numeric_id >= 900_000_000 && numeric_id <= 999_999_999 {
            if let Ok(Some(rec)) = repo::recordings::get_recording_by_numeric_id(&state.db.pool, numeric_id) {
                return serve_local_file(&rec.file_path, &headers).await;
            }
        }
    }

    let source_id = match playlist.source_ids.first() {
        Some(s) => s.clone(),
        None => return (StatusCode::BAD_REQUEST, "No source configured").into_response(),
    };

    let source = match repo::sources::get_source_by_id(&state.db.pool, &source_id) {
        Ok(Some(s)) => s,
        _ => return (StatusCode::BAD_REQUEST, "Source not found").into_response(),
    };

    let user_name = source.username.as_deref().unwrap_or("");
    let pass_word = source.password.as_deref().unwrap_or("");
    let upstream_url = format!("{}/movie/{}/{}/{}.mp4", source.url.trim_end_matches('/'), user_name, pass_word, stream_id);

    // Proxy upstream VOD response
    let client = reqwest::Client::new();
    match client.get(&upstream_url).send().await {
        Ok(resp) if resp.status().is_success() => {
            let content_type = resp
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("video/mp4")
                .to_string();

            let stream = resp.bytes_stream().map(|res| res.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e)));
            let body = Body::from_stream(stream);

            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, content_type)
                .body(body)
                .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
        }
        _ => StatusCode::BAD_GATEWAY.into_response(),
    }
}

pub async fn handle_series_stream(
    State(state): State<AppState>,
    Path((username, password, stream_param)): Path<(String, String, String)>,
) -> Response {
    let stream_id = stream_param
        .split('.')
        .next()
        .unwrap_or(&stream_param)
        .to_string();

    let playlist = match repo::playlists::get_playlist_by_credentials(&state.db.pool, &username, &password) {
        Ok(Some(p)) => p,
        _ => return StatusCode::UNAUTHORIZED.into_response(),
    };

    let source_id = match playlist.source_ids.first() {
        Some(s) => s.clone(),
        None => return (StatusCode::BAD_REQUEST, "No source configured").into_response(),
    };

    let source = match repo::sources::get_source_by_id(&state.db.pool, &source_id) {
        Ok(Some(s)) => s,
        _ => return (StatusCode::BAD_REQUEST, "Source not found").into_response(),
    };

    let user_name = source.username.as_deref().unwrap_or("");
    let pass_word = source.password.as_deref().unwrap_or("");
    let upstream_url = format!("{}/series/{}/{}/{}.mp4", source.url.trim_end_matches('/'), user_name, pass_word, stream_id);

    let client = reqwest::Client::new();
    match client.get(&upstream_url).send().await {
        Ok(resp) if resp.status().is_success() => {
            let stream = resp.bytes_stream().map(|res| res.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e)));
            let body = Body::from_stream(stream);

            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "video/mp4")
                .body(body)
                .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
        }
        _ => StatusCode::BAD_GATEWAY.into_response(),
    }
}

async fn serve_local_file(file_path: &str, _headers: &HeaderMap) -> Response {
    match tokio::fs::File::open(file_path).await {
        Ok(file) => {
            let stream = ReaderStream::new(file);
            let body = Body::from_stream(stream);

            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "video/mp2t")
                .body(body)
                .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
        }
        Err(e) => {
            error!("Failed to open local recording file {}: {}", file_path, e);
            StatusCode::NOT_FOUND.into_response()
        }
    }
}
