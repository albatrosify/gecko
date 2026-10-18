use crate::error::{CoreError, Result};
use rusqlite::Connection;
use std::path::{Path, PathBuf};
use tokio::sync::{mpsc, oneshot};
use tracing::{error, info};

type BoxedWriteOp = Box<dyn FnOnce(&mut Connection) -> Result<()> + Send>;

enum DbWriteMessage {
    Execute {
        op: BoxedWriteOp,
        respond_to: Option<oneshot::Sender<Result<()>>>,
    },
    Shutdown,
}

#[derive(Clone)]
pub struct DbWriterHandle {
    sender: mpsc::Sender<DbWriteMessage>,
}

impl DbWriterHandle {
    pub fn new<P: AsRef<Path>>(db_path: P, channel_capacity: usize) -> Result<Self> {
        let (sender, mut receiver) = mpsc::channel::<DbWriteMessage>(channel_capacity);
        let path = PathBuf::from(db_path.as_ref());

        std::thread::Builder::new()
            .name("gecko-db-writer".to_string())
            .spawn(move || {
                info!("Dedicated DB Writer Actor thread started for {:?}", path);
                let conn_result = Connection::open(&path);
                let mut conn = match conn_result {
                    Ok(c) => c,
                    Err(e) => {
                        error!("Failed to open DB writer connection: {}", e);
                        return;
                    }
                };

                let _ = conn.execute_batch(
                    "PRAGMA journal_mode = WAL;
                     PRAGMA synchronous = NORMAL;
                     PRAGMA foreign_keys = ON;
                     PRAGMA busy_timeout = 5000;",
                );

                while let Some(msg) = receiver.blocking_recv() {
                    match msg {
                        DbWriteMessage::Execute { op, respond_to } => {
                            let res = op(&mut conn);
                            if let Some(tx) = respond_to {
                                let _ = tx.send(res);
                            }
                        }
                        DbWriteMessage::Shutdown => {
                            info!("DB Writer Actor received shutdown signal");
                            break;
                        }
                    }
                }
                info!("DB Writer Actor thread exiting");
            })
            .map_err(|e| CoreError::Other(format!("Failed to spawn DB writer thread: {}", e)))?;

        Ok(Self { sender })
    }

    /// Executes a write closure on the dedicated writer thread and awaits its completion.
    pub async fn write<F, R>(&self, f: F) -> Result<R>
    where
        F: FnOnce(&mut Connection) -> Result<R> + Send + 'static,
        R: Send + 'static,
    {
        let (tx, rx) = oneshot::channel();
        let (result_tx, result_rx) = oneshot::channel::<Result<R>>();

        let op: BoxedWriteOp = Box::new(move |conn| {
            let res = f(conn);
            let _ = result_tx.send(res);
            Ok(())
        });

        self.sender
            .send(DbWriteMessage::Execute {
                op,
                respond_to: Some(tx),
            })
            .await
            .map_err(|_| CoreError::ActorClosed)?;

        // Wait for actor to complete the operation
        rx.await.map_err(|_| CoreError::ActorClosed)??;

        // Extract the result
        result_rx.await.map_err(|_| CoreError::ActorClosed)?
    }

    /// Fires and forgets a write operation without waiting for completion (e.g. logging/stats).
    pub fn write_fire_and_forget<F>(&self, f: F) -> Result<()>
    where
        F: FnOnce(&mut Connection) -> Result<()> + Send + 'static,
    {
        let op: BoxedWriteOp = Box::new(f);
        self.sender
            .try_send(DbWriteMessage::Execute {
                op,
                respond_to: None,
            })
            .map_err(|_| CoreError::ActorClosed)?;
        Ok(())
    }

    /// Gracefully signals the writer actor to terminate.
    pub async fn shutdown(&self) -> Result<()> {
        let _ = self.sender.send(DbWriteMessage::Shutdown).await;
        Ok(())
    }
}
