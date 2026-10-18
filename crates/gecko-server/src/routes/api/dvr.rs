use crate::state::AppState;
use axum::{
    extract::{Extension, Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use gecko_core::crypto::JwtClaims;
use gecko_core::repo;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct RecordChannelPayload {
    pub source_id: String,
    pub stream_id: String,
    pub stream_name: String,
    pub playlist_id: Option<String>,
    pub duration_minutes: Option<u64>,
}

pub async fn list_recordings(
    State(state): State<AppState>,
    Extension(claims): Extension<JwtClaims>,
) -> Response {
    match repo::recordings::list_recordings_by_user(&state.db.pool, &claims.sub) {
        Ok(recordings) => (StatusCode::OK, Json(recordings)).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

pub async fn record_channel(
    State(state): State<AppState>,
    Extension(claims): Extension<JwtClaims>,
    Json(payload): Json<RecordChannelPayload>,
) -> Response {
    let source = match repo::sources::get_source_by_id(&state.db.pool, &payload.source_id) {
        Ok(Some(s)) => s,
        _ => return (StatusCode::BAD_REQUEST, "Source not found").into_response(),
    };

    let user_name = source.username.as_deref().unwrap_or("");
    let pass_word = source.password.as_deref().unwrap_or("");
    let upstream_url = format!(
        "{}/live/{}/{}/{}.ts",
        source.url.trim_end_matches('/'),
        user_name,
        pass_word,
        payload.stream_id
    );

    match state
        .dvr
        .start_recording(
            state.db.clone(),
            state.hub.clone(),
            &claims.sub,
            payload.playlist_id.as_deref(),
            &payload.source_id,
            &payload.stream_id,
            &payload.stream_name,
            &upstream_url,
            payload.duration_minutes,
        )
        .await
    {
        Ok(rec_id) => (
            StatusCode::CREATED,
            Json(serde_json::json!({ "id": rec_id, "status": "recording" })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e })),
        )
            .into_response(),
    }
}

pub async fn stop_recording(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Response {
    let stopped = state.dvr.stop_recording(&id).await;
    if stopped {
        (
            StatusCode::OK,
            Json(serde_json::json!({ "id": id, "status": "stopping" })),
        )
            .into_response()
    } else {
        StatusCode::NOT_FOUND.into_response()
    }
}

pub async fn delete_recording(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Response {
    if let Ok(Some(rec)) = repo::recordings::get_recording_by_id(&state.db.pool, &id) {
        let _ = tokio::fs::remove_file(&rec.file_path).await;
    }

    match state
        .db
        .writer
        .write(move |conn| repo::recordings::delete_recording_sync(conn, &id))
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
