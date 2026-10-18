use crate::state::AppState;
use axum::{
    extract::{Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use gecko_core::repo;
use gecko_core::xtream::XtreamClient;
use serde::Deserialize;
use std::collections::HashMap;

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct M3uQuery {
    pub username: Option<String>,
    pub password: Option<String>,
    pub u: Option<String>,
    pub p: Option<String>,
    #[serde(rename = "type")]
    pub playlist_type: Option<String>,
    pub output: Option<String>,
}

pub async fn handle_m3u(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<M3uQuery>,
) -> Response {
    let username = query.username.or(query.u);
    let password = query.password.or(query.p);

    let (user, pass) = match (username, password) {
        (Some(u), Some(p)) if !u.is_empty() && !p.is_empty() => (u, p),
        _ => return StatusCode::UNAUTHORIZED.into_response(),
    };

    let playlist = match repo::playlists::get_playlist_by_credentials(&state.db.pool, &user, &pass)
    {
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

    let client = XtreamClient::new(
        &source.url,
        source.username.as_deref(),
        source.password.as_deref(),
    );

    let host = headers
        .get("host")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("localhost:3000");

    let categories = client.get_live_categories().await.unwrap_or_default();
    let cat_map: HashMap<String, String> = categories
        .into_iter()
        .map(|c| (c.category_id, c.category_name))
        .collect();

    let streams = client.get_live_streams().await.unwrap_or_default();

    let mut output = String::with_capacity(streams.len() * 200);
    output.push_str("#EXTM3U\n");

    for s in streams {
        let cat_name = cat_map
            .get(&s.category_id)
            .cloned()
            .unwrap_or_else(|| "General".to_string());
        let epg_id = s.epg_channel_id.as_deref().unwrap_or("");
        let logo = s.stream_icon.as_deref().unwrap_or("");

        output.push_str(&format!(
            "#EXTINF:-1 tvg-id=\"{}\" tvg-name=\"{}\" tvg-logo=\"{}\" group-title=\"{}\",{}\n",
            epg_id, s.name, logo, cat_name, s.name
        ));
        output.push_str(&format!(
            "http://{}/live/{}/{}/{}.ts\n",
            host, user, pass, s.stream_id
        ));
    }

    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/octet-stream"),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=\"playlist.m3u\"",
            ),
        ],
        output,
    )
        .into_response()
}
