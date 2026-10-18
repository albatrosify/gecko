use crate::state::AppState;
use axum::{
    extract::{Extension, Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use gecko_core::crypto::JwtClaims;
use gecko_core::models::{CategoryMapping, CategoryMappingExtra, StreamMapping, StreamMappingExtra, StreamType};
use gecko_core::repo;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct PlaylistQuery {
    #[serde(rename = "playlistId")]
    pub playlist_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MappingInput {
    pub id: Option<String>,
    pub playlist_id: Option<String>,
    #[serde(rename = "type")]
    pub mapping_type: Option<StreamType>,
    pub original_id: Option<serde_json::Value>,
    #[serde(flatten)]
    pub extra: StreamMappingExtra,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryMappingInput {
    pub id: Option<String>,
    pub playlist_id: Option<String>,
    #[serde(rename = "type")]
    pub mapping_type: Option<StreamType>,
    pub original_id: Option<serde_json::Value>,
    #[serde(flatten)]
    pub extra: CategoryMappingExtra,
}

#[derive(Debug, Deserialize)]
pub struct BatchMappingsPayload {
    pub updates: Vec<MappingInput>,
}

#[derive(Debug, Deserialize)]
pub struct BatchCategoryMappingsPayload {
    pub updates: Vec<CategoryMappingInput>,
}

#[derive(Debug, Deserialize)]
pub struct ResetMappingsPayload {
    #[serde(default)]
    pub ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct ResetCategoryMappingsPayload {
    #[serde(default)]
    pub ids: Option<Vec<String>>,
    #[serde(rename = "originalIds", default)]
    pub original_ids: Option<Vec<String>>,
    #[serde(rename = "playlistId", default)]
    pub playlist_id: Option<String>,
    #[serde(rename = "type", default)]
    pub mapping_type: Option<String>,
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

pub fn stream_mapping_to_json(m: &StreamMapping) -> serde_json::Value {
    let mut val = serde_json::to_value(&m.extra).unwrap_or(serde_json::json!({}));
    if let serde_json::Value::Object(ref mut map) = val {
        map.insert("id".to_string(), serde_json::Value::String(m.id.clone()));
        map.insert("playlistId".to_string(), serde_json::Value::String(m.playlist_id.clone()));
        map.insert("type".to_string(), serde_json::Value::String(m.mapping_type.as_str().to_string()));
        map.insert("originalId".to_string(), serde_json::Value::String(m.original_id.clone()));
    }
    val
}

pub fn category_mapping_to_json(cm: &CategoryMapping) -> serde_json::Value {
    let mut val = serde_json::to_value(&cm.extra).unwrap_or(serde_json::json!({}));
    if let serde_json::Value::Object(ref mut map) = val {
        map.insert("id".to_string(), serde_json::Value::String(cm.id.clone()));
        map.insert("playlistId".to_string(), serde_json::Value::String(cm.playlist_id.clone()));
        map.insert("type".to_string(), serde_json::Value::String(cm.mapping_type.as_str().to_string()));
        map.insert("originalId".to_string(), serde_json::Value::String(cm.original_id.clone()));
    }
    val
}

// =====================================
// Stream Mappings Handlers
// =====================================

pub async fn list_mappings(
    State(state): State<AppState>,
    Extension(claims): Extension<JwtClaims>,
    Query(q): Query<PlaylistQuery>,
) -> Response {
    if !check_ownership(&state, &q.playlist_id, &claims) {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({ "error": "Access denied" }))).into_response();
    }

    match repo::mappings::get_mappings_by_playlist(&state.db.pool, &q.playlist_id) {
        Ok(mappings) => {
            let json_list: Vec<serde_json::Value> = mappings.iter().map(stream_mapping_to_json).collect();
            (StatusCode::OK, Json(json_list)).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e.to_string() }))).into_response(),
    }
}

pub async fn create_mapping(
    State(state): State<AppState>,
    Extension(claims): Extension<JwtClaims>,
    Json(payload): Json<MappingInput>,
) -> Response {
    let playlist_id = match payload.playlist_id {
        Some(id) => id,
        None => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": "playlistId required" }))).into_response(),
    };
    let mapping_type = match payload.mapping_type {
        Some(t) => t,
        None => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": "type required" }))).into_response(),
    };
    let original_id = match payload.original_id {
        Some(ref val) => val_to_string(val),
        None => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": "originalId required" }))).into_response(),
    };

    if !check_ownership(&state, &playlist_id, &claims) {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({ "error": "Access denied" }))).into_response();
    }

    let new_id = payload.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let mapping = StreamMapping {
        id: new_id,
        playlist_id,
        mapping_type,
        original_id,
        extra: payload.extra,
    };

    let mapping_clone = mapping.clone();
    match state.db.writer.write(move |conn| repo::mappings::insert_mapping_sync(conn, &mapping_clone)).await {
        Ok(_) => (StatusCode::CREATED, Json(stream_mapping_to_json(&mapping))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e.to_string() }))).into_response(),
    }
}

pub async fn update_mapping(
    State(state): State<AppState>,
    Extension(claims): Extension<JwtClaims>,
    Path(id): Path<String>,
    Json(payload): Json<MappingInput>,
) -> Response {
    let existing = match repo::mappings::get_mapping_by_id(&state.db.pool, &id) {
        Ok(Some(m)) => m,
        Ok(None) => return (StatusCode::NOT_FOUND, Json(serde_json::json!({ "error": "Mapping not found" }))).into_response(),
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e.to_string() }))).into_response(),
    };

    if !check_ownership(&state, &existing.playlist_id, &claims) {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({ "error": "Access denied" }))).into_response();
    }

    let updated = StreamMapping {
        id: id.clone(),
        playlist_id: payload.playlist_id.unwrap_or(existing.playlist_id),
        mapping_type: payload.mapping_type.unwrap_or(existing.mapping_type),
        original_id: payload.original_id.map(|v| val_to_string(&v)).unwrap_or(existing.original_id),
        extra: payload.extra,
    };

    let updated_clone = updated.clone();
    match state.db.writer.write(move |conn| repo::mappings::insert_mapping_sync(conn, &updated_clone)).await {
        Ok(_) => (StatusCode::OK, Json(serde_json::json!({ "success": true }))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e.to_string() }))).into_response(),
    }
}

pub async fn delete_mapping(
    State(state): State<AppState>,
    Extension(claims): Extension<JwtClaims>,
    Path(id): Path<String>,
) -> Response {
    let existing = match repo::mappings::get_mapping_by_id(&state.db.pool, &id) {
        Ok(Some(m)) => m,
        Ok(None) => return (StatusCode::NOT_FOUND, Json(serde_json::json!({ "error": "Mapping not found" }))).into_response(),
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e.to_string() }))).into_response(),
    };

    if !check_ownership(&state, &existing.playlist_id, &claims) {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({ "error": "Access denied" }))).into_response();
    }

    let id_clone = id.clone();
    match state.db.writer.write(move |conn| repo::mappings::delete_mapping_sync(conn, &id_clone)).await {
        Ok(_) => (StatusCode::OK, Json(serde_json::json!({ "success": true }))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e.to_string() }))).into_response(),
    }
}

pub async fn batch_mappings(
    State(state): State<AppState>,
    Extension(claims): Extension<JwtClaims>,
    Json(payload): Json<BatchMappingsPayload>,
) -> Response {
    let mut mappings = Vec::new();
    for item in payload.updates {
        let playlist_id = match item.playlist_id {
            Some(pid) => pid,
            None => continue,
        };
        if !check_ownership(&state, &playlist_id, &claims) {
            return (StatusCode::FORBIDDEN, Json(serde_json::json!({ "error": "Access denied" }))).into_response();
        }
        let original_id = match item.original_id {
            Some(v) => val_to_string(&v),
            None => continue,
        };
        let mapping_type = item.mapping_type.unwrap_or(StreamType::Live);
        let id = item.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        mappings.push(StreamMapping {
            id,
            playlist_id,
            mapping_type,
            original_id,
            extra: item.extra,
        });
    }

    let count = mappings.len();
    match state.db.writer.write(move |conn| repo::mappings::upsert_mappings_batch_sync(conn, &mappings)).await {
        Ok(_) => (StatusCode::OK, Json(serde_json::json!({ "success": true, "count": count }))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e.to_string() }))).into_response(),
    }
}

pub async fn reset_mappings(
    State(state): State<AppState>,
    Extension(_claims): Extension<JwtClaims>,
    Json(payload): Json<ResetMappingsPayload>,
) -> Response {
    let ids = payload.ids;
    match state.db.writer.write(move |conn| repo::mappings::delete_mappings_by_ids_sync(conn, &ids)).await {
        Ok(_) => (StatusCode::OK, Json(serde_json::json!({ "success": true }))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e.to_string() }))).into_response(),
    }
}

// =====================================
// Category Mappings Handlers
// =====================================

pub async fn list_category_mappings(
    State(state): State<AppState>,
    Extension(claims): Extension<JwtClaims>,
    Query(q): Query<PlaylistQuery>,
) -> Response {
    if !check_ownership(&state, &q.playlist_id, &claims) {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({ "error": "Access denied" }))).into_response();
    }

    match repo::mappings::get_all_category_mappings_by_playlist(&state.db.pool, &q.playlist_id) {
        Ok(mappings) => {
            let json_list: Vec<serde_json::Value> = mappings.iter().map(category_mapping_to_json).collect();
            (StatusCode::OK, Json(json_list)).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e.to_string() }))).into_response(),
    }
}

pub async fn create_category_mapping(
    State(state): State<AppState>,
    Extension(claims): Extension<JwtClaims>,
    Json(payload): Json<CategoryMappingInput>,
) -> Response {
    let playlist_id = match payload.playlist_id {
        Some(id) => id,
        None => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": "playlistId required" }))).into_response(),
    };
    let mapping_type = match payload.mapping_type {
        Some(t) => t,
        None => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": "type required" }))).into_response(),
    };
    let original_id = match payload.original_id {
        Some(ref val) => val_to_string(val),
        None => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": "originalId required" }))).into_response(),
    };

    if !check_ownership(&state, &playlist_id, &claims) {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({ "error": "Access denied" }))).into_response();
    }

    let new_id = payload.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let mapping = CategoryMapping {
        id: new_id,
        playlist_id,
        mapping_type,
        original_id,
        extra: payload.extra,
    };

    let mapping_clone = mapping.clone();
    match state.db.writer.write(move |conn| repo::mappings::insert_category_mapping_sync(conn, &mapping_clone)).await {
        Ok(_) => (StatusCode::CREATED, Json(category_mapping_to_json(&mapping))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e.to_string() }))).into_response(),
    }
}

pub async fn update_category_mapping(
    State(state): State<AppState>,
    Extension(claims): Extension<JwtClaims>,
    Path(id): Path<String>,
    Json(payload): Json<CategoryMappingInput>,
) -> Response {
    let existing = match repo::mappings::get_category_mapping_by_id(&state.db.pool, &id) {
        Ok(Some(m)) => m,
        Ok(None) => return (StatusCode::NOT_FOUND, Json(serde_json::json!({ "error": "Category mapping not found" }))).into_response(),
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e.to_string() }))).into_response(),
    };

    if !check_ownership(&state, &existing.playlist_id, &claims) {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({ "error": "Access denied" }))).into_response();
    }

    let updated = CategoryMapping {
        id: id.clone(),
        playlist_id: payload.playlist_id.unwrap_or(existing.playlist_id),
        mapping_type: payload.mapping_type.unwrap_or(existing.mapping_type),
        original_id: payload.original_id.map(|v| val_to_string(&v)).unwrap_or(existing.original_id),
        extra: payload.extra,
    };

    let updated_clone = updated.clone();
    match state.db.writer.write(move |conn| repo::mappings::insert_category_mapping_sync(conn, &updated_clone)).await {
        Ok(_) => (StatusCode::OK, Json(serde_json::json!({ "success": true }))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e.to_string() }))).into_response(),
    }
}

pub async fn delete_category_mapping(
    State(state): State<AppState>,
    Extension(claims): Extension<JwtClaims>,
    Path(id): Path<String>,
) -> Response {
    let existing = match repo::mappings::get_category_mapping_by_id(&state.db.pool, &id) {
        Ok(Some(m)) => m,
        Ok(None) => return (StatusCode::NOT_FOUND, Json(serde_json::json!({ "error": "Category mapping not found" }))).into_response(),
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e.to_string() }))).into_response(),
    };

    if !check_ownership(&state, &existing.playlist_id, &claims) {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({ "error": "Access denied" }))).into_response();
    }

    let id_clone = id.clone();
    match state.db.writer.write(move |conn| repo::mappings::delete_category_mapping_sync(conn, &id_clone)).await {
        Ok(_) => (StatusCode::OK, Json(serde_json::json!({ "success": true }))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e.to_string() }))).into_response(),
    }
}

pub async fn batch_category_mappings(
    State(state): State<AppState>,
    Extension(claims): Extension<JwtClaims>,
    Json(payload): Json<BatchCategoryMappingsPayload>,
) -> Response {
    let mut mappings = Vec::new();
    for item in payload.updates {
        let playlist_id = match item.playlist_id {
            Some(pid) => pid,
            None => continue,
        };
        if !check_ownership(&state, &playlist_id, &claims) {
            return (StatusCode::FORBIDDEN, Json(serde_json::json!({ "error": "Access denied" }))).into_response();
        }
        let original_id = match item.original_id {
            Some(v) => val_to_string(&v),
            None => continue,
        };
        let mapping_type = item.mapping_type.unwrap_or(StreamType::Live);
        let id = item.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        mappings.push(CategoryMapping {
            id,
            playlist_id,
            mapping_type,
            original_id,
            extra: item.extra,
        });
    }

    let count = mappings.len();
    match state.db.writer.write(move |conn| repo::mappings::upsert_category_mappings_batch_sync(conn, &mappings)).await {
        Ok(_) => (StatusCode::OK, Json(serde_json::json!({ "success": true, "count": count }))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e.to_string() }))).into_response(),
    }
}

pub async fn reset_category_mappings(
    State(state): State<AppState>,
    Extension(_claims): Extension<JwtClaims>,
    Json(payload): Json<ResetCategoryMappingsPayload>,
) -> Response {
    if let Some(ids) = payload.ids {
        let _ = state.db.writer.write(move |conn| repo::mappings::delete_category_mappings_by_ids_sync(conn, &ids)).await;
    }
    (StatusCode::OK, Json(serde_json::json!({ "success": true }))).into_response()
}
