use crate::state::AppState;
use axum::{
    extract::{Extension, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use gecko_core::crypto::JwtClaims;
use gecko_core::models::{CategoryMapping, CustomCategory, CustomCategoryItem, Playlist, Source, StreamMapping};
use gecko_core::repo;
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
pub struct ExportQuery {
    #[serde(rename = "playlistId")]
    pub playlist_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistBackupData {
    pub playlist: Playlist,
    #[serde(default)]
    pub mappings: Vec<StreamMapping>,
    #[serde(default)]
    pub category_mappings: Vec<CategoryMapping>,
    #[serde(default)]
    pub custom_categories: Vec<CustomCategory>,
    #[serde(default)]
    pub custom_category_items: Vec<CustomCategoryItem>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FullBackupData {
    pub version: u32,
    pub exported_at: String,
    #[serde(default)]
    pub sources: Vec<Source>,
    #[serde(default)]
    pub playlists: Vec<Playlist>,
    #[serde(default)]
    pub mappings: Vec<StreamMapping>,
    #[serde(default)]
    pub category_mappings: Vec<CategoryMapping>,
    #[serde(default)]
    pub custom_categories: Vec<CustomCategory>,
    #[serde(default)]
    pub custom_category_items: Vec<CustomCategoryItem>,
    #[serde(default)]
    pub settings: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum ImportPayload {
    Playlist(PlaylistBackupData),
    Full(FullBackupData),
}

fn check_playlist_ownership(state: &AppState, playlist_id: &str, claims: &JwtClaims) -> bool {
    if claims.role == "admin" {
        return true;
    }
    match repo::playlists::get_playlist_by_id(&state.db.pool, playlist_id) {
        Ok(Some(p)) => p.user_id == claims.sub,
        _ => false,
    }
}

pub async fn export_backup(
    State(state): State<AppState>,
    Extension(claims): Extension<JwtClaims>,
    Query(q): Query<ExportQuery>,
) -> Response {
    if let Some(ref playlist_id) = q.playlist_id {
        if !check_playlist_ownership(&state, playlist_id, &claims) {
            return (StatusCode::FORBIDDEN, Json(serde_json::json!({ "error": "Access denied" }))).into_response();
        }

        let playlist = match repo::playlists::get_playlist_by_id(&state.db.pool, playlist_id) {
            Ok(Some(p)) => p,
            _ => return (StatusCode::NOT_FOUND, Json(serde_json::json!({ "error": "Playlist not found" }))).into_response(),
        };

        let mappings = repo::mappings::get_mappings_by_playlist(&state.db.pool, playlist_id).unwrap_or_default();
        let category_mappings = repo::mappings::get_all_category_mappings_by_playlist(&state.db.pool, playlist_id).unwrap_or_default();
        let custom_categories = repo::custom_categories::get_all_custom_categories_by_playlist(&state.db.pool, playlist_id).unwrap_or_default();
        let custom_category_items = repo::custom_categories::get_all_custom_category_items_by_playlist(&state.db.pool, playlist_id).unwrap_or_default();

        let backup = PlaylistBackupData {
            playlist,
            mappings,
            category_mappings,
            custom_categories,
            custom_category_items,
        };

        return (StatusCode::OK, Json(backup)).into_response();
    }

    // Full export
    let playlists = if claims.role == "admin" {
        repo::playlists::list_all_playlists(&state.db.pool).unwrap_or_default()
    } else {
        repo::playlists::list_playlists_by_user(&state.db.pool, &claims.sub).unwrap_or_default()
    };

    let sources = if claims.role == "admin" {
        repo::sources::list_all_sources(&state.db.pool).unwrap_or_default()
    } else {
        repo::sources::list_sources_by_user(&state.db.pool, &claims.sub).unwrap_or_default()
    };

    let mut all_mappings = Vec::new();
    let mut all_category_mappings = Vec::new();
    let mut all_custom_categories = Vec::new();
    let mut all_custom_category_items = Vec::new();

    for p in &playlists {
        if let Ok(m) = repo::mappings::get_mappings_by_playlist(&state.db.pool, &p.id) {
            all_mappings.extend(m);
        }
        if let Ok(cm) = repo::mappings::get_all_category_mappings_by_playlist(&state.db.pool, &p.id) {
            all_category_mappings.extend(cm);
        }
        if let Ok(cc) = repo::custom_categories::get_all_custom_categories_by_playlist(&state.db.pool, &p.id) {
            all_custom_categories.extend(cc);
        }
        if let Ok(cci) = repo::custom_categories::get_all_custom_category_items_by_playlist(&state.db.pool, &p.id) {
            all_custom_category_items.extend(cci);
        }
    }

    let settings = if claims.role == "admin" {
        repo::settings::get_setting(&state.db.pool, "global").ok().flatten()
    } else {
        None
    };

    let full_backup = FullBackupData {
        version: 2,
        exported_at: chrono::Utc::now().to_rfc3339(),
        sources,
        playlists,
        mappings: all_mappings,
        category_mappings: all_category_mappings,
        custom_categories: all_custom_categories,
        custom_category_items: all_custom_category_items,
        settings,
    };

    (StatusCode::OK, Json(full_backup)).into_response()
}

pub async fn import_backup(
    State(state): State<AppState>,
    Extension(claims): Extension<JwtClaims>,
    Json(payload): Json<ImportPayload>,
) -> Response {
    match payload {
        ImportPayload::Playlist(p_data) => {
            let mut playlist = p_data.playlist;
            // Associate with current importing user unless user is admin
            if claims.role != "admin" {
                playlist.user_id = claims.sub.clone();
            }

            let mappings = p_data.mappings;
            let category_mappings = p_data.category_mappings;
            let custom_categories = p_data.custom_categories;
            let custom_category_items = p_data.custom_category_items;

            let m_count = mappings.len();
            let cm_count = category_mappings.len();
            let cc_count = custom_categories.len();
            let cci_count = custom_category_items.len();

            let playlist_clone = playlist.clone();
            let write_res = state.db.writer.write(move |conn| {
                repo::playlists::upsert_playlist_sync(conn, &playlist_clone)?;
                if !mappings.is_empty() {
                    repo::mappings::upsert_mappings_batch_sync(conn, &mappings)?;
                }
                if !category_mappings.is_empty() {
                    repo::mappings::upsert_category_mappings_batch_sync(conn, &category_mappings)?;
                }
                for cc in &custom_categories {
                    let _ = repo::custom_categories::insert_custom_category_sync(conn, cc);
                }
                if !custom_category_items.is_empty() {
                    repo::custom_categories::upsert_custom_category_items_batch_sync(conn, &custom_category_items)?;
                }
                Ok(())
            }).await;

            match write_res {
                Ok(_) => (
                    StatusCode::OK,
                    Json(serde_json::json!({
                        "success": true,
                        "imported": {
                            "playlists": 1,
                            "mappings": m_count,
                            "categoryMappings": cm_count,
                            "customCategories": cc_count,
                            "customCategoryItems": cci_count
                        }
                    })),
                ).into_response(),
                Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e.to_string() }))).into_response(),
            }
        }
        ImportPayload::Full(full) => {
            let user_id = claims.sub.clone();
            let is_admin = claims.role == "admin";

            let sources: Vec<Source> = full.sources.into_iter().map(|mut s| {
                if !is_admin { s.user_id = user_id.clone(); }
                s
            }).collect();

            let playlists: Vec<Playlist> = full.playlists.into_iter().map(|mut p| {
                if !is_admin { p.user_id = user_id.clone(); }
                p
            }).collect();

            let mappings = full.mappings;
            let category_mappings = full.category_mappings;
            let custom_categories = full.custom_categories;
            let custom_category_items = full.custom_category_items;
            let settings = full.settings;

            let s_count = sources.len();
            let p_count = playlists.len();
            let m_count = mappings.len();
            let cm_count = category_mappings.len();
            let cc_count = custom_categories.len();
            let cci_count = custom_category_items.len();

            let write_res = state.db.writer.write(move |conn| {
                for s in &sources {
                    repo::sources::upsert_source_sync(conn, s)?;
                }
                for p in &playlists {
                    repo::playlists::upsert_playlist_sync(conn, p)?;
                }
                if !mappings.is_empty() {
                    repo::mappings::upsert_mappings_batch_sync(conn, &mappings)?;
                }
                if !category_mappings.is_empty() {
                    repo::mappings::upsert_category_mappings_batch_sync(conn, &category_mappings)?;
                }
                for cc in &custom_categories {
                    let _ = repo::custom_categories::insert_custom_category_sync(conn, cc);
                }
                if !custom_category_items.is_empty() {
                    repo::custom_categories::upsert_custom_category_items_batch_sync(conn, &custom_category_items)?;
                }
                if is_admin {
                    if let Some(ref set_val) = settings {
                        repo::settings::upsert_setting_sync(conn, "global", set_val)?;
                    }
                }
                Ok(())
            }).await;

            match write_res {
                Ok(_) => (
                    StatusCode::OK,
                    Json(serde_json::json!({
                        "success": true,
                        "imported": {
                            "sources": s_count,
                            "playlists": p_count,
                            "mappings": m_count,
                            "categoryMappings": cm_count,
                            "customCategories": cc_count,
                            "customCategoryItems": cci_count
                        }
                    })),
                ).into_response(),
                Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e.to_string() }))).into_response(),
            }
        }
    }
}
