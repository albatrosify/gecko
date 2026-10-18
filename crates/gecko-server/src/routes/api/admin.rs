use crate::state::AppState;
use axum::{
    extract::{Extension, Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use gecko_core::crypto::JwtClaims;
use gecko_core::models::UserSummary;
use gecko_core::repo;

pub async fn list_users(
    State(state): State<AppState>,
    Extension(claims): Extension<JwtClaims>,
) -> Response {
    if claims.role != "admin" {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "Admin access required" })),
        )
            .into_response();
    }

    match repo::users::list_users(&state.db.pool) {
        Ok(users) => {
            let summaries: Vec<UserSummary> = users.into_iter().map(UserSummary::from).collect();
            (StatusCode::OK, Json(summaries)).into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

pub async fn delete_user(
    State(state): State<AppState>,
    Extension(claims): Extension<JwtClaims>,
    Path(id): Path<String>,
) -> Response {
    if claims.role != "admin" {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "Admin access required" })),
        )
            .into_response();
    }

    match state
        .db
        .writer
        .write(move |conn| repo::users::delete_user_sync(conn, &id))
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
