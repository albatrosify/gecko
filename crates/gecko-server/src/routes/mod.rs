pub mod api;
pub mod m3u;
pub mod player_api;
pub mod static_files;
pub mod stream;
pub mod xmltv;

use crate::state::AppState;
use axum::{routing::get, Router};

pub fn create_router() -> Router<AppState> {
    Router::new()
        .route("/health", get(api::system::handle_health))
        .route("/player_api.php", get(player_api::handle_player_api).post(player_api::handle_player_api))
        .route("/get.php", get(m3u::handle_m3u))
        .route("/xmltv.php", get(xmltv::handle_xmltv))
        .route("/live/{username}/{password}/{stream_param}", get(stream::handle_live_stream))
        .route("/movie/{username}/{password}/{stream_param}", get(stream::handle_movie_stream))
        .route("/series/{username}/{password}/{stream_param}", get(stream::handle_series_stream))
        .nest("/api", api::create_api_router())
        .fallback(static_files::handle_static_files)
}
