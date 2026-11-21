use anyhow::Result;
use axum::extract::State;
use axum::http::{header, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::Router;
use hololive_ocg_tracker::api::{build_api_router, AppState};
use hololive_ocg_tracker::{db, importer};
use std::env;
use std::net::SocketAddr;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use tokio::fs;
use tokio::sync::Notify;
use tower_http::cors::CorsLayer;

#[tokio::main]
async fn main() -> Result<()> {
    let resources_dir = PathBuf::from(
        env::var("HOLOLIVE_RESOURCES_DIR").unwrap_or_else(|_| "resources".to_string()),
    );
    let db_path = PathBuf::from(
        env::var("HOLOLIVE_DB_PATH").unwrap_or_else(|_| {
            resources_dir
                .join("hololive_ocg.db")
                .to_string_lossy()
                .into_owned()
        }),
    );
    let static_dir =
        PathBuf::from(env::var("HOLOLIVE_STATIC_DIR").unwrap_or_else(|_| "static".to_string()));

    let database = db::sqlite::Database::open(&db_path)?;
    db::init_schema(&database)?;

    let sync = importer::sync_resources_to_db(&database, &resources_dir, false)?;
    println!(
        "Hololive OCG DB ready at {} | editions={} cards={} skipped_existing={}",
        db_path.display(),
        sync.editions_synced,
        sync.cards_synced,
        sync.skipped_already_populated
    );

    let shutdown_notify = Arc::new(Notify::new());
    let db_for_shutdown = database.clone();

    let state = AppState {
        db: database,
        resources_dir,
        shutdown_notify: shutdown_notify.clone(),
    };

    let static_router = Router::new()
        .fallback(serve_static)
        .with_state(static_dir);

    let app = Router::new()
        .nest("/api", build_api_router(state))
        .merge(static_router)
        .layer(CorsLayer::permissive());

    let host = env::var("HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port: u16 = env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8080);
    let addr: SocketAddr = format!("{host}:{port}").parse()?;

    println!("Hololive OCG Collection Tracker listening on http://{addr}");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal(shutdown_notify))
        .await?;

    let _ = db_for_shutdown.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
    let _ = std::fs::remove_file(".hocg.pid");
    println!("Hololive OCG Collection Tracker stopped cleanly.");

    Ok(())
}

async fn shutdown_signal(notify: Arc<Notify>) {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut sigterm) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            sigterm.recv().await;
        } else {
            std::future::pending::<()>().await;
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
        _ = notify.notified() => {},
    }
}

async fn serve_static(State(static_dir): State<PathBuf>, uri: Uri) -> Response {
    let raw_path = uri.path().trim_start_matches('/');
    let rel_path = if raw_path.is_empty() {
        "index.html"
    } else {
        raw_path
    };

    let candidate = Path::new(rel_path);
    for comp in candidate.components() {
        if matches!(
            comp,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        ) {
            return (StatusCode::FORBIDDEN, "Forbidden").into_response();
        }
    }

    let full_path = static_dir.join(candidate);
    let target_path = if full_path.is_file() {
        full_path
    } else if !rel_path.contains('.') {
        static_dir.join("index.html")
    } else {
        return (StatusCode::NOT_FOUND, "Not found").into_response();
    };

    match fs::read(&target_path).await {
        Ok(bytes) => {
            let mime = content_type_for_path(&target_path);
            ([(header::CONTENT_TYPE, mime)], bytes).into_response()
        }
        Err(_) => (StatusCode::NOT_FOUND, "Not found").into_response(),
    }
}

fn content_type_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "html" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "application/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}
