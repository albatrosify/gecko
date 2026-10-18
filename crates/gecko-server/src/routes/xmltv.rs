use crate::state::AppState;
use axum::{
    body::Body,
    extract::{Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use flate2::read::GzDecoder;
use gecko_core::epg::{build_playlist_epg, get_epg_cache_path};
use gecko_core::repo;
use serde::Deserialize;
use std::io::Read;
use tokio_util::io::ReaderStream;
use tracing::error;

#[derive(Debug, Deserialize)]
pub struct XmltvQuery {
    pub username: Option<String>,
    pub password: Option<String>,
    pub u: Option<String>,
    pub p: Option<String>,
}

pub async fn handle_xmltv(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<XmltvQuery>,
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

    let cache_path = get_epg_cache_path(&playlist.id);

    // If cache does not exist, build it
    if !cache_path.exists() {
        let sources = repo::sources::get_sources_by_ids(&state.db.pool, &playlist.source_ids)
            .unwrap_or_default();
        let epgs: Vec<gecko_core::models::EpgSource> = Vec::new(); // Custom EPGs if any

        if let Err(e) = build_playlist_epg(&playlist, &sources, &epgs).await {
            error!("Failed to build EPG cache for {}: {}", playlist.id, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    }

    let accept_encoding = headers
        .get(header::ACCEPT_ENCODING)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");

    // Fast-path: Client accepts gzip -> stream .xml.gz file directly without decompressing!
    if accept_encoding.contains("gzip") {
        match tokio::fs::File::open(&cache_path).await {
            Ok(file) => {
                let stream = ReaderStream::new(file);
                let body = Body::from_stream(stream);

                Response::builder()
                    .status(StatusCode::OK)
                    .header(header::CONTENT_TYPE, "application/xml; charset=utf-8")
                    .header(header::CONTENT_ENCODING, "gzip")
                    .header(header::CACHE_CONTROL, "public, max-age=3600")
                    .body(body)
                    .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
            }
            Err(_) => StatusCode::NOT_FOUND.into_response(),
        }
    } else {
        // Fallback: Client does not accept gzip -> decompress and stream raw XML
        match tokio::fs::read(&cache_path).await {
            Ok(compressed_bytes) => {
                let mut decoder = GzDecoder::new(&compressed_bytes[..]);
                let mut xml = Vec::new();
                if decoder.read_to_end(&mut xml).is_ok() {
                    Response::builder()
                        .status(StatusCode::OK)
                        .header(header::CONTENT_TYPE, "application/xml; charset=utf-8")
                        .header(header::CACHE_CONTROL, "public, max-age=3600")
                        .body(Body::from(xml))
                        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
                } else {
                    StatusCode::INTERNAL_SERVER_ERROR.into_response()
                }
            }
            Err(_) => StatusCode::NOT_FOUND.into_response(),
        }
    }
}
