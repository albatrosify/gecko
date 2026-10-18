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
