use crate::state::AppState;
use axum::{
    extract::{Extension, Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use gecko_core::crypto::JwtClaims;
use gecko_core::models::{CustomCategory, CustomCategoryItem, StreamType};
use gecko_core::repo;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct PlaylistQuery {
    #[serde(rename = "playlistId")]
    pub playlist_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateCategoryPayload {
    pub playlist_id: Option<String>,
    #[serde(rename = "type")]
    pub category_type: StreamType,
    pub name: String,
    #[serde(default)]
    pub order: i32,
    #[serde(default)]
    pub hidden: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCategoryPayload {
    pub name: Option<String>,
    pub order: Option<i32>,
    pub hidden: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateItemPayload {
    pub id: Option<String>,
    pub custom_category_id: String,
    pub playlist_id: Option<String>,
    #[serde(rename = "type")]
    pub item_type: StreamType,
    pub upstream_stream_id: serde_json::Value,
    pub upstream_source_id: String,
    pub stream_id: serde_json::Value,
    pub extra: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
pub struct BatchItemsPayload {
    pub items: Vec<CreateItemPayload>,
    #[serde(rename = "playlistId", default)]
    pub playlist_id: Option<String>,
}

fn val_to_string(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Number(n) => n.to_string(),
        other => other.to_string(),
    }
}

fn check_ownership(state: &AppState, playlist_id: &str, claims: &JwtClaims) -> bool {
    if claims.role == "admin" {
        return true;
    }
    match repo::playlists::get_playlist_by_id(&state.db.pool, playlist_id) {
        Ok(Some(p)) => p.user_id == claims.sub,
        _ => false,
    }
}

// =====================================
// Custom Categories Handlers
// =====================================

pub async fn list_custom_categories(
    State(state): State<AppState>,
    Extension(claims): Extension<JwtClaims>,
    Query(q): Query<PlaylistQuery>,
) -> Response {
    if !check_ownership(&state, &q.playlist_id, &claims) {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({ "error": "Access denied" }))).into_response();
    }

    match repo::custom_categories::get_all_custom_categories_by_playlist(&state.db.pool, &q.playlist_id) {
        Ok(cats) => (StatusCode::OK, Json(cats)).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e.to_string() }))).into_response(),
    }
}

pub async fn create_custom_category(
    State(state): State<AppState>,
    Extension(claims): Extension<JwtClaims>,
    Json(payload): Json<CreateCategoryPayload>,
) -> Response {
    let playlist_id = match payload.playlist_id {
        Some(pid) => pid,
        None => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": "playlistId required" }))).into_response(),
    };

    if !check_ownership(&state, &playlist_id, &claims) {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({ "error": "Access denied" }))).into_response();
    }

    let cat = CustomCategory {
        id: uuid::Uuid::new_v4().to_string(),
        playlist_id,
        custom_type: payload.category_type,
        name: payload.name.trim().to_string(),
        order: payload.order,
        hidden: payload.hidden,
    };

    let cat_clone = cat.clone();
    match state.db.writer.write(move |conn| repo::custom_categories::insert_custom_category_sync(conn, &cat_clone)).await {
        Ok(_) => (StatusCode::CREATED, Json(cat)).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e.to_string() }))).into_response(),
    }
}

pub async fn update_custom_category(
    State(state): State<AppState>,
    Extension(claims): Extension<JwtClaims>,
    Path(id): Path<String>,
    Json(payload): Json<UpdateCategoryPayload>,
) -> Response {
    let existing = match repo::custom_categories::get_custom_category_by_id(&state.db.pool, &id) {
        Ok(Some(c)) => c,
        Ok(None) => return (StatusCode::NOT_FOUND, Json(serde_json::json!({ "error": "Custom category not found" }))).into_response(),
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e.to_string() }))).into_response(),
    };

    if !check_ownership(&state, &existing.playlist_id, &claims) {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({ "error": "Access denied" }))).into_response();
    }

    let updated = CustomCategory {
        id: id.clone(),
        playlist_id: existing.playlist_id,
        custom_type: existing.custom_type,
        name: payload.name.unwrap_or(existing.name),
        order: payload.order.unwrap_or(existing.order),
        hidden: payload.hidden.unwrap_or(existing.hidden),
    };

    let updated_clone = updated.clone();
    match state.db.writer.write(move |conn| repo::custom_categories::update_custom_category_sync(conn, &updated_clone)).await {
        Ok(_) => (StatusCode::OK, Json(serde_json::json!({ "success": true }))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e.to_string() }))).into_response(),
    }
}

pub async fn delete_custom_category(
    State(state): State<AppState>,
    Extension(claims): Extension<JwtClaims>,
    Path(id): Path<String>,
) -> Response {
    let existing = match repo::custom_categories::get_custom_category_by_id(&state.db.pool, &id) {
        Ok(Some(c)) => c,
        Ok(None) => return (StatusCode::NOT_FOUND, Json(serde_json::json!({ "error": "Custom category not found" }))).into_response(),
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e.to_string() }))).into_response(),
    };

    if !check_ownership(&state, &existing.playlist_id, &claims) {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({ "error": "Access denied" }))).into_response();
    }

    let id_clone = id.clone();
    match state.db.writer.write(move |conn| repo::custom_categories::delete_custom_category_sync(conn, &id_clone)).await {
        Ok(_) => (StatusCode::OK, Json(serde_json::json!({ "success": true }))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e.to_string() }))).into_response(),
    }
}

// =====================================
// Custom Category Items Handlers
// =====================================

pub async fn list_custom_category_items(
    State(state): State<AppState>,
    Extension(claims): Extension<JwtClaims>,
    Query(q): Query<PlaylistQuery>,
) -> Response {
    if !check_ownership(&state, &q.playlist_id, &claims) {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({ "error": "Access denied" }))).into_response();
    }

    match repo::custom_categories::get_all_custom_category_items_by_playlist(&state.db.pool, &q.playlist_id) {
        Ok(items) => (StatusCode::OK, Json(items)).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e.to_string() }))).into_response(),
    }
}

pub async fn create_custom_category_item(
    State(state): State<AppState>,
    Extension(claims): Extension<JwtClaims>,
    Json(payload): Json<CreateItemPayload>,
) -> Response {
    let playlist_id = match payload.playlist_id {
        Some(pid) => pid,
        None => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": "playlistId required" }))).into_response(),
    };

    if !check_ownership(&state, &playlist_id, &claims) {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({ "error": "Access denied" }))).into_response();
    }

    let item = CustomCategoryItem {
        id: payload.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        custom_category_id: payload.custom_category_id,
        playlist_id,
        item_type: payload.item_type,
        upstream_stream_id: val_to_string(&payload.upstream_stream_id),
        upstream_source_id: payload.upstream_source_id,
        stream_id: val_to_string(&payload.stream_id),
        extra: payload.extra,
    };

    let item_clone = item.clone();
    match state.db.writer.write(move |conn| repo::custom_categories::insert_custom_category_item_sync(conn, &item_clone)).await {
        Ok(_) => (StatusCode::CREATED, Json(item)).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e.to_string() }))).into_response(),
    }
}

pub async fn batch_custom_category_items(
    State(state): State<AppState>,
    Extension(claims): Extension<JwtClaims>,
    Json(payload): Json<BatchItemsPayload>,
) -> Response {
    let fallback_playlist_id = payload.playlist_id;
    let mut items = Vec::new();

    for raw in payload.items {
        let playlist_id = match raw.playlist_id.or_else(|| fallback_playlist_id.clone()) {
            Some(pid) => pid,
            None => continue,
        };
        if !check_ownership(&state, &playlist_id, &claims) {
            return (StatusCode::FORBIDDEN, Json(serde_json::json!({ "error": "Access denied" }))).into_response();
        }

        items.push(CustomCategoryItem {
            id: raw.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            custom_category_id: raw.custom_category_id,
            playlist_id,
            item_type: raw.item_type,
            upstream_stream_id: val_to_string(&raw.upstream_stream_id),
            upstream_source_id: raw.upstream_source_id,
            stream_id: val_to_string(&raw.stream_id),
            extra: raw.extra,
        });
    }

    let count = items.len();
    match state.db.writer.write(move |conn| repo::custom_categories::upsert_custom_category_items_batch_sync(conn, &items)).await {
        Ok(_) => (StatusCode::OK, Json(serde_json::json!({ "success": true, "count": count }))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e.to_string() }))).into_response(),
    }
}

pub async fn delete_custom_category_item(
    State(state): State<AppState>,
    Extension(claims): Extension<JwtClaims>,
    Path(id): Path<String>,
) -> Response {
    let existing = match repo::custom_categories::get_custom_category_item_by_id(&state.db.pool, &id) {
        Ok(Some(i)) => i,
        Ok(None) => return (StatusCode::NOT_FOUND, Json(serde_json::json!({ "error": "Item not found" }))).into_response(),
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e.to_string() }))).into_response(),
    };

    if !check_ownership(&state, &existing.playlist_id, &claims) {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({ "error": "Access denied" }))).into_response();
    }

    let id_clone = id.clone();
    match state.db.writer.write(move |conn| repo::custom_categories::delete_custom_category_item_sync(conn, &id_clone)).await {
        Ok(_) => (StatusCode::OK, Json(serde_json::json!({ "success": true }))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e.to_string() }))).into_response(),
    }
}
