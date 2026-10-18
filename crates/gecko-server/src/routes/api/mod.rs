pub mod auth;
pub mod backup;
pub mod custom_categories;
pub mod dvr;
pub mod mappings;
pub mod playlists;
pub mod sources;
pub mod system;
pub mod traffic;

use crate::state::AppState;
use axum::{
    middleware,
    routing::{delete, get, post, put},
    Router,
};

pub fn create_api_router() -> Router<AppState> {
    let public_routes = Router::new()
        .route("/login", post(auth::handle_login))
        .route("/register", post(auth::handle_register));

    let protected_routes = Router::new()
        .route("/auth/me", get(auth::handle_me))
        // Sources
        .route("/sources", get(sources::list_sources).post(sources::create_source))
        .route("/sources/{id}", get(sources::get_source).put(sources::update_source).delete(sources::delete_source))
        // Playlists
        .route("/playlists", get(playlists::list_playlists).post(playlists::create_playlist))
        .route("/playlists/{id}", get(playlists::get_playlist).put(playlists::update_playlist).delete(playlists::delete_playlist))
        // Stream Mappings
        .route("/mappings", get(mappings::list_mappings).post(mappings::create_mapping))
        .route("/mappings/{id}", put(mappings::update_mapping).delete(mappings::delete_mapping))
        .route("/mappings/batch", post(mappings::batch_mappings))
        .route("/mappings/reset", post(mappings::reset_mappings))
        // Category Mappings
        .route("/category-mappings", get(mappings::list_category_mappings).post(mappings::create_category_mapping))
        .route("/category-mappings/{id}", put(mappings::update_category_mapping).delete(mappings::delete_category_mapping))
        .route("/category-mappings/batch", post(mappings::batch_category_mappings))
        .route("/category-mappings/reset", post(mappings::reset_category_mappings))
        // Custom Categories & Items
        .route("/custom-categories", get(custom_categories::list_custom_categories).post(custom_categories::create_custom_category))
        .route("/custom-categories/{id}", put(custom_categories::update_custom_category).delete(custom_categories::delete_custom_category))
        .route("/custom-category-items", get(custom_categories::list_custom_category_items).post(custom_categories::create_custom_category_item))
        .route("/custom-category-items/{id}", delete(custom_categories::delete_custom_category_item))
        .route("/custom-category-items/batch", post(custom_categories::batch_custom_category_items))
        // DVR
        .route("/dvr/recordings", get(dvr::list_recordings))
        .route("/dvr/record-channel", post(dvr::record_channel))
        .route("/dvr/recordings/{id}/stop", post(dvr::stop_recording))
        .route("/dvr/recordings/{id}", delete(dvr::delete_recording))
        // Traffic
        .route("/traffic/stats", get(traffic::get_traffic_stats))
        // System & Proxy
        .route("/system/ip", get(system::handle_ip))
        .route("/system/vpn", get(system::handle_vpn))
        .route("/system/vpn/reconnect", post(system::handle_vpn_reconnect))
        .route("/system/logs", get(system::handle_logs))
        .route("/proxy/stats", get(system::handle_proxy_stats))
        .route("/proxy/streams/{id}/kill", post(system::kill_stream))
        .route("/proxy/streams/kill-all", post(system::kill_all_streams))
        .route("/settings", get(system::get_settings).patch(system::update_settings))
        .route("/settings/telegram/test", post(system::test_telegram))
        // Backup & Migration
        .route("/backup/export", get(backup::export_backup))
        .route("/backup/import", post(backup::import_backup))
        .layer(middleware::from_fn(auth::require_auth_middleware));

    Router::new()
        .route("/health", get(system::handle_health))
        .route("/version", get(system::handle_version))
        .nest("/auth", public_routes)
        .merge(protected_routes)
}
