pub mod crypto;
pub mod db;
pub mod epg;
pub mod error;
pub mod models;
pub mod xtream;

pub use crypto::*;
pub use db::*;
pub use epg::*;
pub use error::*;
pub use models::*;
pub use xtream::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_database_and_repositories() {
        let db = Database::in_memory().unwrap();

        // 1. Create a user via writer actor
        let user_id = uuid::Uuid::new_v4().to_string();
        let pass_hash = crypto::hash_password("admin123").unwrap();
        let user = User {
            id: user_id.clone(),
            email: "admin@gecko.tv".to_string(),
            password: pass_hash,
            role: UserRole::Admin,
            created_at: Some(chrono::Utc::now().timestamp()),
        };

        let user_clone = user.clone();
        db.writer
            .write(move |conn| repo::users::insert_user_sync(conn, &user_clone))
            .await
            .unwrap();

        // 2. Query user from pool
        let fetched = repo::users::get_user_by_email(&db.pool, "admin@gecko.tv")
            .unwrap()
            .expect("User should exist");
        assert_eq!(fetched.id, user_id);
        assert_eq!(fetched.role, UserRole::Admin);

        // 3. Create a source
        let source_id = uuid::Uuid::new_v4().to_string();
        let source = Source {
            id: source_id.clone(),
            user_id: user_id.clone(),
            name: "Test Xtream".to_string(),
            source_type: SourceType::Xtream,
            url: "http://example.com:8080".to_string(),
            username: Some("user".to_string()),
            password: Some("pass".to_string()),
            auto_sync_enabled: true,
            sync_cron: Some("0 4 * * *".to_string()),
            extra: SourceExtra::default(),
        };

        let source_clone = source.clone();
        db.writer
            .write(move |conn| repo::sources::insert_source_sync(conn, &source_clone))
            .await
            .unwrap();

        let fetched_source = repo::sources::get_source_by_id(&db.pool, &source_id)
            .unwrap()
            .expect("Source should exist");
        assert_eq!(fetched_source.name, "Test Xtream");
        assert_eq!(fetched_source.source_type, SourceType::Xtream);

        // 4. Create a playlist
        let playlist_id = uuid::Uuid::new_v4().to_string();
        let playlist = Playlist {
            id: playlist_id.clone(),
            user_id: user_id.clone(),
            name: "Living Room".to_string(),
            username: "livingroom".to_string(),
            password: "secretpassword".to_string(),
            source_ids: vec![source_id.clone()],
            direct_streams: false,
            extra: PlaylistExtra::default(),
        };

        let playlist_clone = playlist.clone();
        db.writer
            .write(move |conn| repo::playlists::insert_playlist_sync(conn, &playlist_clone))
            .await
            .unwrap();

        let fetched_playlist = repo::playlists::get_playlist_by_credentials(
            &db.pool,
            "livingroom",
            "secretpassword",
        )
        .unwrap()
        .expect("Playlist should exist");
        assert_eq!(fetched_playlist.name, "Living Room");
        assert_eq!(fetched_playlist.source_ids, vec![source_id]);

        // 5. Test recording and numeric ID mapping
        let rec_id = "rec_550e8400-e29b-41d4-a716-446655440000";
        let numeric_id = recording_id_to_numeric(rec_id);
        assert!(numeric_id >= 900_000_000 && numeric_id <= 999_999_999);

        let recording = Recording {
            id: rec_id.to_string(),
            user_id: user_id.clone(),
            playlist_id: Some(playlist_id.clone()),
            source_id: "src_1".to_string(),
            stream_id: "stream_123".to_string(),
            stream_name: "Formula 1 Live".to_string(),
            channel_name: Some("Sky Sport F1".to_string()),
            stream_type: StreamType::Live,
            status: RecordingStatus::Recording,
            start_time: chrono::Utc::now().to_rfc3339(),
            end_time: None,
            duration_seconds: 120,
            file_size_bytes: 45_000_000,
            file_path: "/data/recordings/f1.ts".to_string(),
            extra: None,
        };

        let rec_clone = recording.clone();
        db.writer
            .write(move |conn| repo::recordings::insert_recording_sync(conn, &rec_clone))
            .await
            .unwrap();

        let fetched_rec = repo::recordings::get_recording_by_numeric_id(&db.pool, numeric_id)
            .unwrap()
            .expect("Recording should be found by numeric ID");
        assert_eq!(fetched_rec.stream_name, "Formula 1 Live");

        // 6. Test orphaned recordings reconciliation
        let reconciled = db
            .writer
            .write(|conn| repo::recordings::reconcile_orphaned_recordings_sync(conn))
            .await
            .unwrap();
        assert_eq!(reconciled, 1);

        let reconciled_rec = repo::recordings::get_recording_by_id(&db.pool, rec_id)
            .unwrap()
            .unwrap();
        assert_eq!(reconciled_rec.status, RecordingStatus::Completed);

        // 7. Test atomic traffic stats
        db.writer
            .write(|conn| {
                repo::traffic::record_traffic_bytes_sync(
                    conn,
                    "2026-10-18",
                    "p_1",
                    "Living Room",
                    "live",
                    10_000_000,
                    1729272000,
                )?;
                repo::traffic::record_traffic_bytes_sync(
                    conn,
                    "2026-10-18",
                    "p_1",
                    "Living Room",
                    "live",
                    5_000_000,
                    1729272100,
                )
            })
            .await
            .unwrap();

        let traffic = repo::traffic::get_traffic_stats_for_range(
            &db.pool,
            "2026-10-01",
            "2026-10-31",
            100_000_000,
        )
        .unwrap();
        assert_eq!(traffic.total_bytes, 15_000_000);
        assert_eq!(traffic.by_type.live, 15_000_000);
        assert_eq!(traffic.by_playlist[0].total_bytes, 15_000_000);

        // Graceful shutdown of writer actor
        db.writer.shutdown().await.unwrap();
    }
}
