use axum::body::Body;
use axum::http::{Request, StatusCode};
use gecko_core::models::{
    recording_id_to_numeric, Playlist, PlaylistExtra, Recording, RecordingStatus, Source,
    SourceExtra, SourceType, StreamType,
};
use gecko_core::{repo, Database};
use gecko_server::{create_router, AppState};
use http_body_util::BodyExt;
use tower::ServiceExt;

#[tokio::test]
async fn test_player_api_authentication_and_dvr_metadata() {
    let db = Database::in_memory().unwrap();

    // Insert test source
    let source_id = "src_123".to_string();
    let source = Source {
        id: source_id.clone(),
        user_id: "user_1".to_string(),
        name: "Test Provider".to_string(),
        source_type: SourceType::Xtream,
        url: "http://127.0.0.1:9999".to_string(), // dummy
        username: Some("provider_user".to_string()),
        password: Some("provider_pass".to_string()),
        auto_sync_enabled: false,
        sync_cron: None,
        extra: SourceExtra::default(),
    };
    db.writer
        .write({
            let s = source.clone();
            move |conn| repo::sources::insert_source_sync(conn, &s)
        })
        .await
        .unwrap();

    // Insert test playlist
    let playlist_id = "pl_123".to_string();
    let playlist = Playlist {
        id: playlist_id.clone(),
        user_id: "user_1".to_string(),
        name: "Living Room".to_string(),
        username: "livingroom".to_string(),
        password: "secretpassword".to_string(),
        source_ids: vec![source_id.clone()],
        direct_streams: false,
        extra: PlaylistExtra::default(),
    };
    db.writer
        .write({
            let p = playlist.clone();
            move |conn| repo::playlists::insert_playlist_sync(conn, &p)
        })
        .await
        .unwrap();

    // Insert a completed DVR recording
    let rec_id = "rec_a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    let numeric_id = recording_id_to_numeric(rec_id);
    let recording = Recording {
        id: rec_id.to_string(),
        user_id: "user_1".to_string(),
        playlist_id: Some(playlist_id.clone()),
        source_id: source_id.clone(),
        stream_id: "stream_live_1".to_string(),
        stream_name: "UEFA Champions League Final".to_string(),
        channel_name: Some("Sky Sport 1".to_string()),
        stream_type: StreamType::Live,
        status: RecordingStatus::Completed,
        start_time: "2026-10-18T20:00:00Z".to_string(),
        end_time: Some("2026-10-18T22:00:00Z".to_string()),
        duration_seconds: 7200,
        file_size_bytes: 4_500_000_000,
        file_path: "/data/recordings/ucl.ts".to_string(),
        extra: None,
    };
    db.writer
        .write({
            let r = recording.clone();
            move |conn| repo::recordings::insert_recording_sync(conn, &r)
        })
        .await
        .unwrap();

    let state = AppState::new(db.clone());
    let app = create_router().with_state(state);

    // 1. Missing credentials
    let req = Request::builder()
        .uri("/player_api.php")
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = resp.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["status"], "error");
    assert_eq!(json["message"], "Missing credentials");

    // 2. Invalid credentials
    let req = Request::builder()
        .uri("/player_api.php?username=wrong&password=wrong")
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    let body = resp.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["status"], "error");
    assert_eq!(json["message"], "Invalid credentials");

    // 3. get_vod_categories includes DVR category 999999
    let req = Request::builder()
        .uri("/player_api.php?username=livingroom&password=secretpassword&action=get_vod_categories")
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = resp.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let dvr_cat = json
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["category_id"] == "999999")
        .expect("DVR category 999999 must be present");
    assert_eq!(dvr_cat["category_name"], "DVR Recordings");

    // 4. get_vod_streams includes DVR recording with deterministic numeric stream_id
    let req = Request::builder()
        .uri("/player_api.php?username=livingroom&password=secretpassword&action=get_vod_streams")
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = resp.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let dvr_stream = json
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["stream_id"] == numeric_id)
        .expect("DVR stream with numeric ID must be present");
    assert_eq!(dvr_stream["name"], "UEFA Champions League Final");
    assert_eq!(dvr_stream["category_id"], "999999");
    assert_eq!(dvr_stream["container_extension"], "ts");

    // 5. get_vod_info returns DVR metadata for numeric stream_id
    let req = Request::builder()
        .uri(&format!(
            "/player_api.php?username=livingroom&password=secretpassword&action=get_vod_info&vod_id={}",
            numeric_id
        ))
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = resp.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["info"]["name"], "UEFA Champions League Final");
    assert_eq!(json["movie_data"]["stream_id"], numeric_id);
    assert_eq!(json["movie_data"]["category_id"], "999999");

    // 6. Test Static file delivery & SPA Fallback
    let req = Request::builder()
        .uri("/playlists")
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = resp.into_body().collect().await.unwrap().to_bytes();
    let body_str = String::from_utf8_lossy(&body);
    assert!(body_str.contains("<title>GECKO") || body_str.contains("<div id=\"root\"></div>"));

    // 7. Test /xmltv.php streaming
    let req = Request::builder()
        .uri("/xmltv.php?username=livingroom&password=secretpassword")
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = resp.into_body().collect().await.unwrap().to_bytes();
    let body_str = String::from_utf8_lossy(&body);
    assert!(body_str.contains("<tv"));

    // 8. Test REST API: register and login
    let register_payload = serde_json::json!({
        "email": "owner@gecko.tv",
        "password": "owner_secure_password"
    });
    let req = Request::builder()
        .method("POST")
        .uri("/api/auth/register")
        .header("Content-Type", "application/json")
        .body(Body::from(serde_json::to_vec(&register_payload).unwrap()))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = resp.into_body().collect().await.unwrap().to_bytes();
    let auth_json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let token = auth_json["token"].as_str().expect("Token must be present");
    assert!(!token.is_empty());

    // 9. Test REST API: create and list sources with Bearer token
    let source_payload = serde_json::json!({
        "name": "Primary M3U Feed",
        "type": "m3u",
        "url": "http://streams.example.com/playlist.m3u",
        "auto_sync_enabled": true
    });
    let req = Request::builder()
        .method("POST")
        .uri("/api/sources")
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", token))
        .body(Body::from(serde_json::to_vec(&source_payload).unwrap()))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::CREATED);

    let req = Request::builder()
        .uri("/api/sources")
        .header("Authorization", format!("Bearer {}", token))
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = resp.into_body().collect().await.unwrap().to_bytes();
    let sources_list: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(sources_list.as_array().unwrap().len(), 1);
    assert_eq!(sources_list[0]["name"], "Primary M3U Feed");

    // 10. Test REST API: create and list stream mappings
    let mapping_payload = serde_json::json!({
        "playlistId": playlist.id,
        "type": "live",
        "originalId": 12345,
        "customName": "Renamed Channel HD",
        "order": 1,
        "hidden": false
    });
    let req = Request::builder()
        .method("POST")
        .uri("/api/mappings")
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", token))
        .body(Body::from(serde_json::to_vec(&mapping_payload).unwrap()))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::CREATED);

    let req = Request::builder()
        .uri(format!("/api/mappings?playlistId={}", playlist.id))
        .header("Authorization", format!("Bearer {}", token))
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = resp.into_body().collect().await.unwrap().to_bytes();
    let mappings_list: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(mappings_list.as_array().unwrap().len(), 1);
    assert_eq!(mappings_list[0]["customName"], "Renamed Channel HD");

    // 11. Test REST API: create and list custom categories
    let custom_cat_payload = serde_json::json!({
        "playlistId": playlist.id,
        "type": "live",
        "name": "Sports Favorites",
        "order": 1,
        "hidden": false
    });
    let req = Request::builder()
        .method("POST")
        .uri("/api/custom-categories")
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", token))
        .body(Body::from(serde_json::to_vec(&custom_cat_payload).unwrap()))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::CREATED);

    let req = Request::builder()
        .uri(format!("/api/custom-categories?playlistId={}", playlist.id))
        .header("Authorization", format!("Bearer {}", token))
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = resp.into_body().collect().await.unwrap().to_bytes();
    let cats_list: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(cats_list.as_array().unwrap().len(), 1);
    assert_eq!(cats_list[0]["name"], "Sports Favorites");

    // 12. Test REST API: System Settings and Proxy Stats
    let req = Request::builder()
        .uri("/api/settings")
        .header("Authorization", format!("Bearer {}", token))
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let req = Request::builder()
        .uri("/api/proxy/stats")
        .header("Authorization", format!("Bearer {}", token))
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = resp.into_body().collect().await.unwrap().to_bytes();
    let stats_json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(stats_json["totalPlaylists"].as_i64().unwrap() >= 1);

    // 13. Test REST API: Export backup
    let req = Request::builder()
        .uri("/api/backup/export")
        .header("Authorization", format!("Bearer {}", token))
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = resp.into_body().collect().await.unwrap().to_bytes();
    let backup_json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(backup_json["version"], 2);
    assert!(!backup_json["playlists"].as_array().unwrap().is_empty());
    assert!(!backup_json["mappings"].as_array().unwrap().is_empty());

    // 14. Test REST API: Import backup
    let req = Request::builder()
        .method("POST")
        .uri("/api/backup/import")
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", token))
        .body(Body::from(body))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = resp.into_body().collect().await.unwrap().to_bytes();
    let import_result: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(import_result["success"], true);

    // Shutdown actor
    db.writer.shutdown().await.unwrap();
}

