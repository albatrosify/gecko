use crate::state::AppState;
use axum::{
    extract::{Extension, Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use gecko_core::crypto::JwtClaims;
use gecko_core::models::EpgSource;
use gecko_core::repo;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateEpgPayload {
    pub name: String,
    pub url: String,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

pub async fn list_epgs(
    State(state): State<AppState>,
    Extension(claims): Extension<JwtClaims>,
) -> Response {
    match repo::epgs::list_epgs_by_user(&state.db.pool, &claims.sub) {
        Ok(epgs) => (StatusCode::OK, Json(epgs)).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

pub async fn create_epg(
    State(state): State<AppState>,
    Extension(claims): Extension<JwtClaims>,
    Json(payload): Json<CreateEpgPayload>,
) -> Response {
    let mut extra = payload.extra;
    extra.insert("enabled".into(), serde_json::json!(true));

    let epg = EpgSource {
        id: uuid::Uuid::new_v4().to_string(),
        user_id: claims.sub,
        name: payload.name.trim().to_string(),
        url: payload.url.trim().to_string(),
        enabled: true,
        extra,
    };

    let epg_clone = epg.clone();
    match state
        .db
        .writer
        .write(move |conn| repo::epgs::insert_epg_sync(conn, &epg_clone))
        .await
    {
        Ok(_) => (StatusCode::CREATED, Json(eppg_clone_resp(&epg))).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

fn eppg_clone_resp(epg: &EpgSource) -> serde_json::Value {
    serde_json::to_value(epg).unwrap_or_else(|_| serde_json::json!({ "id": epg.id }))
}

pub async fn delete_epg(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Response {
    match state
        .db
        .writer
        .write(move |conn| repo::epgs::delete_epg_sync(conn, &id))
        .await
    {
        Ok(_) => (StatusCode::OK, Json(serde_json::json!({ "success": true }))).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

pub async fn get_epg_channels() -> Response {
    (StatusCode::OK, Json(serde_json::json!({ "channels": [] }))).into_response()
}

