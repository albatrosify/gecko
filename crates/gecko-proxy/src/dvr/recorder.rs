use crate::multiplexer::StreamHub;
use gecko_core::models::{Recording, RecordingStatus, StreamType};
use gecko_core::{repo, Database};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::sync::{oneshot, RwLock};
use tracing::{error, info, warn};

pub fn get_recordings_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("DVR_STORAGE_PATH") {
        PathBuf::from(dir)
    } else {
        PathBuf::from("data/recordings")
    }
}

pub struct ActiveRecording {
    pub recording_id: String,
    pub stop_tx: Option<oneshot::Sender<()>>,
}

#[derive(Clone)]
pub struct DvrRecorder {
    active_sessions: Arc<RwLock<HashMap<String, oneshot::Sender<()>>>>,
}

impl DvrRecorder {
    pub fn new() -> Self {
        Self {
            active_sessions: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn start_recording(
        &self,
        db: Database,
        hub: StreamHub,
        user_id: &str,
        playlist_id: Option<&str>,
        source_id: &str,
        stream_id: &str,
        stream_name: &str,
        upstream_url: &str,
        duration_minutes: Option<u64>,
    ) -> Result<String, String> {
        let rec_id = format!("rec_{}", uuid::Uuid::new_v4());
        let storage_dir = get_recordings_dir();
        let _ = tokio::fs::create_dir_all(&storage_dir).await;

        let file_path = storage_dir.join(format!("{}.ts", rec_id));
        let file_path_str = file_path.to_string_lossy().to_string();

        let recording = Recording {
            id: rec_id.clone(),
            user_id: user_id.to_string(),
            playlist_id: playlist_id.map(|s| s.to_string()),
            source_id: source_id.to_string(),
            stream_id: stream_id.to_string(),
            stream_name: stream_name.to_string(),
            channel_name: Some(stream_name.to_string()),
            stream_type: StreamType::Live,
            status: RecordingStatus::Recording,
            start_time: chrono::Utc::now().to_rfc3339(),
            end_time: None,
            duration_seconds: 0,
            file_size_bytes: 0,
            file_path: file_path_str.clone(),
            extra: None,
        };

        // Persist initial recording state
        db.writer
            .write({
                let r = recording.clone();
                move |conn| repo::recordings::insert_recording_sync(conn, &r)
            })
            .await
            .map_err(|e| format!("DB insert error: {}", e))?;

        let (stop_tx, mut stop_rx) = oneshot::channel();
        self.active_sessions
            .write()
            .await
            .insert(rec_id.clone(), stop_tx);

        let channel_key = format!("{}_{}", source_id, stream_id);
        let mut rx = hub.subscribe(&channel_key, upstream_url, None).await;

        let active_map = self.active_sessions.clone();
        let rec_id_clone = rec_id.clone();
        let start_time = Instant::now();

        tokio::spawn(async move {
            info!("DVR recording '{}' started -> {}", rec_id_clone, file_path_str);
            let file_res = tokio::fs::File::create(&file_path).await;
            let mut file = match file_res {
                Ok(f) => f,
                Err(e) => {
                    error!("Failed to create recording file: {}", e);
                    let _ = db
                        .writer
                        .write({
                            let id = rec_id_clone.clone();
                            move |conn| {
                                if let Ok(Some(mut r)) = repo::recordings::get_recording_by_id(&db.pool, &id) {
                                    r.status = RecordingStatus::Failed;
                                    let _ = repo::recordings::update_recording_sync(conn, &r);
                                }
                                Ok(())
                            }
                        })
                        .await;
                    active_map.write().await.remove(&rec_id_clone);
                    return;
                }
            };

            let mut total_bytes: u64 = 0;
            let auto_stop_duration = duration_minutes.map(Duration::from_secs).map(|d| d * 60);

            loop {
                tokio::select! {
                    _ = &mut stop_rx => {
                        info!("DVR recording '{}' received manual stop signal", rec_id_clone);
                        break;
                    }
                    chunk_res = rx.recv() => {
                        match chunk_res {
                            Ok(chunk) => {
                                if let Err(e) = file.write_all(&chunk).await {
                                    error!("Failed writing to recording file: {}", e);
                                    break;
                                }
                                total_bytes += chunk.len() as u64;

                                if let Some(max_dur) = auto_stop_duration {
                                    if start_time.elapsed() >= max_dur {
                                        info!("DVR recording '{}' reached duration limit of {:?}, auto-stopping", rec_id_clone, max_dur);
                                        break;
                                    }
                                }
                            }
                            Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                                warn!("DVR recording lagged, skipped {} chunks", skipped);
                            }
                            Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                                info!("Upstream stream closed for recording '{}'", rec_id_clone);
                                break;
                            }
                        }
                    }
                }
            }

            let _ = file.flush().await;
            let duration_secs = start_time.elapsed().as_secs();

            info!(
                "DVR recording '{}' completed ({} seconds, {} MB)",
                rec_id_clone,
                duration_secs,
                total_bytes / 1_000_000
            );

            // Update final recording metadata in DB
            let _ = db
                .writer
                .write({
                    let id = rec_id_clone.clone();
                    move |conn| {
                        if let Ok(Some(mut r)) = repo::recordings::get_recording_by_id(&db.pool, &id) {
                            r.status = RecordingStatus::Completed;
                            r.end_time = Some(chrono::Utc::now().to_rfc3339());
                            r.duration_seconds = duration_secs;
                            r.file_size_bytes = total_bytes;
                            let _ = repo::recordings::update_recording_sync(conn, &r);
                        }
                        Ok(())
                    }
                })
                .await;

            active_map.write().await.remove(&rec_id_clone);
        });

        Ok(rec_id)
    }

    pub async fn stop_recording(&self, recording_id: &str) -> bool {
        let mut active = self.active_sessions.write().await;
        if let Some(stop_tx) = active.remove(recording_id) {
            let _ = stop_tx.send(());
            true
        } else {
            false
        }
    }

    /// Lossless PTS timestamp remux using FFmpeg.
    pub async fn repair_recording(input_path: &Path, output_path: &Path) -> Result<(), String> {
        let ffmpeg_cmd = std::env::var("FFMPEG_PATH").unwrap_or_else(|_| "ffmpeg".to_string());
        let status = Command::new(&ffmpeg_cmd)
            .args([
                "-y",
                "-err_detect",
                "ignore_err",
                "-fflags",
                "+genpts+discardcorrupt",
                "-i",
                &input_path.to_string_lossy(),
                "-c",
                "copy",
                &output_path.to_string_lossy(),
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .status()
            .await
            .map_err(|e| format!("Failed to spawn ffmpeg: {}", e))?;

        if status.success() {
            Ok(())
        } else {
            Err(format!("FFmpeg exited with code: {:?}", status.code()))
        }
    }
}
