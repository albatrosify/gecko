use crate::state::AppState;
use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use gecko_core::repo;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct TrafficQuery {
    #[serde(rename = "startDate")]
    pub start_date: Option<String>,
    #[serde(rename = "endDate")]
    pub end_date: Option<String>,
}

pub async fn get_traffic_stats(
    State(state): State<AppState>,
    Query(query): Query<TrafficQuery>,
) -> Response {
    let now = chrono::Utc::now();
    let default_start = (now - chrono::Duration::days(30)).format("%Y-%m-%d").to_string();
    let default_end = now.format("%Y-%m-%d").to_string();

    let start = query.start_date.unwrap_or(default_start);
    let end = query.end_date.unwrap_or(default_end);

    match repo::traffic::get_traffic_stats_for_range(&state.db.pool, &start, &end, 0) {
        Ok(stats) => (StatusCode::OK, Json(stats)).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}
