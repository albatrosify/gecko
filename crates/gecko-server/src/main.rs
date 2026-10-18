use axum::Router;
use gecko_core::Database;
use gecko_server::{create_router, spawn_background_tasks, AppState};
use std::net::SocketAddr;
use std::path::PathBuf;
use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // 1. Initialize structured logging
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "gecko=debug,tower_http=info,axum=trace,info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    info!("Starting GECKO v2 (Rust Edition 2024)");

    // 2. Resolve database path
    let db_path = std::env::var("SQLITE_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("data/gecko.db"));

    info!("Connecting to SQLite database at {:?}", db_path);
    let db = Database::open(&db_path)?;

    // 3. Reconcile orphaned recordings on startup
    let _ = db
        .writer
        .write(|conn| gecko_core::repo::recordings::reconcile_orphaned_recordings_sync(conn))
        .await;

    // 4. Construct AppState
    let state = AppState::new(db);
    spawn_background_tasks(state.clone());

    // 5. Build Axum Router
    let app: Router = create_router().with_state(state);

    // 6. Bind HTTP listener
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3000);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    info!("GECKO v2 listening on http://{}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    info!("GECKO v2 server stopped gracefully");
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install signal handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }

    info!("Shutdown signal received, starting graceful teardown");
}
