use crate::state::AppState;
use axum::{
    extract::{Extension, Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use gecko_core::crypto::JwtClaims;
use gecko_core::models::{Playlist, PlaylistExtra};
use gecko_core::repo;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePlaylistPayload {
    pub name: String,
    pub username: String,
    pub password: String,
    #[serde(default)]
    pub source_ids: Vec<String>,
    #[serde(default)]
    pub direct_streams: bool,
    #[serde(flatten, default)]
    pub extra: PlaylistExtra,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePlaylistPayload {
    pub name: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub source_ids: Option<Vec<String>>,
    pub direct_streams: Option<bool>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

pub async fn list_playlists(
    State(state): State<AppState>,
    Extension(claims): Extension<JwtClaims>,
) -> Response {
    match repo::playlists::list_playlists_by_user(&state.db.pool, &claims.sub) {
        Ok(playlists) => (StatusCode::OK, Json(playlists)).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

pub async fn create_playlist(
    State(state): State<AppState>,
    Extension(claims): Extension<JwtClaims>,
    Json(payload): Json<CreatePlaylistPayload>,
) -> Response {
    let playlist = Playlist {
        id: uuid::Uuid::new_v4().to_string(),
        user_id: claims.sub,
        name: payload.name,
        username: payload.username,
        password: payload.password,
        source_ids: payload.source_ids,
        direct_streams: payload.direct_streams,
        extra: payload.extra,
    };

    let playlist_clone = playlist.clone();
    match state
        .db
        .writer
        .write(move |conn| repo::playlists::insert_playlist_sync(conn, &playlist_clone))
        .await
    {
        Ok(_) => (StatusCode::CREATED, Json(playlist)).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

pub async fn get_playlist(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Response {
    match repo::playlists::get_playlist_by_id(&state.db.pool, &id) {
        Ok(Some(playlist)) => (StatusCode::OK, Json(playlist)).into_response(),
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

pub async fn update_playlist(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(payload): Json<UpdatePlaylistPayload>,
) -> Response {
    let existing = match repo::playlists::get_playlist_by_id(&state.db.pool, &id) {
        Ok(Some(p)) => p,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": e.to_string() })),
            )
                .into_response()
        }
    };

    if let Some(ref new_username) = payload.username {
        if new_username != &existing.username {
            if let Ok(Some(_)) = repo::playlists::get_playlist_by_username(&state.db.pool, new_username) {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({ "error": "Playlist username already in use" })),
                )
                    .into_response();
            }
        }
    }

    // Merge extra fields
    let mut extra_val = serde_json::to_value(&existing.extra).unwrap_or_else(|_| serde_json::json!({}));
    if let serde_json::Value::Object(ref mut map) = extra_val {
        for (k, v) in payload.extra {
            if k != "id" && k != "userId" && k != "name" && k != "username" && k != "password" && k != "sourceIds" && k != "directStreams" {
                map.insert(k, v);
            }
        }
    }
    let merged_extra: PlaylistExtra = serde_json::from_value(extra_val).unwrap_or(existing.extra);

    let updated = Playlist {
        id: id.clone(),
        user_id: existing.user_id,
        name: payload.name.unwrap_or(existing.name),
        username: payload.username.unwrap_or(existing.username),
        password: payload.password.unwrap_or(existing.password),
        source_ids: payload.source_ids.unwrap_or(existing.source_ids),
        direct_streams: payload.direct_streams.unwrap_or(existing.direct_streams),
        extra: merged_extra,
    };

    let updated_clone = updated.clone();
    match state
        .db
        .writer
        .write(move |conn| repo::playlists::update_playlist_sync(conn, &updated_clone))
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

pub async fn delete_playlist(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Response {
    match state
        .db
        .writer
        .write(move |conn| repo::playlists::delete_playlist_sync(conn, &id))
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
