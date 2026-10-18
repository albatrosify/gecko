use axum::{
    body::Body,
    http::{header, StatusCode, Uri},
    response::{IntoResponse, Response},
};
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "../../dist"]
pub struct FrontendAssets;

pub async fn handle_static_files(uri: Uri) -> Response {
    if uri.path().starts_with("/api") {
        return (
            StatusCode::NOT_FOUND,
            axum::Json(serde_json::json!({ "error": "API route not found" })),
        )
            .into_response();
    }

    let path = uri.path().trim_start_matches('/');
    let file_path = if path.is_empty() { "index.html" } else { path };

    if let Some(file) = FrontendAssets::get(file_path) {
        let mime = mime_guess::from_path(file_path).first_or_octet_stream();
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mime.as_ref())
            .header(header::CACHE_CONTROL, "public, max-age=3600")
            .body(Body::from(file.data))
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
    }

    // SPA fallback: any unmatched client-side route serves index.html
    if let Some(index) = FrontendAssets::get("index.html") {
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
            .header(header::CACHE_CONTROL, "no-cache")
            .body(Body::from(index.data))
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
    }

    StatusCode::NOT_FOUND.into_response()
}
