mod app;
mod db;
mod handlers;
mod metrics;
mod models;
mod session;
mod ssh_config;

use axum::routing::{delete, get, post};
use axum::Router;
use std::path::PathBuf;
use tower_http::services::{ServeDir, ServeFile};

fn static_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("SSH_WEB_STATIC_DIR") {
        return PathBuf::from(dir);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("web")
        .join("dist")
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let db_path = db::get_db_path();
    let conn = db::connect()?;
    db::ensure_database(&conn)?;
    println!("Database connected: {}", db_path.display());

    app::init_app(conn);

    let index = static_dir().join("index.html");
    let app = Router::new()
        .route("/api/health", get(|| async { "ok" }))
        .route("/api/connections", get(handlers::get_connections))
        .route("/api/connections", post(handlers::post_connection))
        .route("/api/connections/test", post(handlers::test_connection))
        .route(
            "/api/connections/{id}",
            get(handlers::get_connection)
                .put(handlers::put_connection)
                .delete(handlers::delete_connection),
        )
        .route(
            "/api/connections/{id}/tmux-sessions",
            get(app::get_tmux_sessions),
        )
        .route(
            "/api/connections/{id}/tmux-sessions/{name}",
            delete(app::delete_tmux_session),
        )
        .route("/api/connections/import", post(handlers::import_connections))
        .route("/api/ssh-config/hosts", get(handlers::discover_ssh_hosts))
        .route("/api/connections/{id}/metrics", get(app::get_metrics))
        .route("/api/connections/{id}/terminal", get(app::get_terminal_ws))
        .fallback_service(ServeDir::new(static_dir()).fallback(ServeFile::new(index)));

    let port = std::env::var("PORT")
        .ok()
        .and_then(|port| port.parse::<u16>().ok())
        .unwrap_or(8091);
    let host = std::env::var("HOST").unwrap_or_else(|_| "0.0.0.0".to_string());
    let address = format!("{host}:{port}");
    let listener = tokio::net::TcpListener::bind(&address).await?;

    println!("Server running on http://{host}:{port}");
    axum::serve(listener, app).await?;
    Ok(())
}
