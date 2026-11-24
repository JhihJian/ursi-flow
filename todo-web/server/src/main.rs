use anyhow::Result;
use axum::{
    routing::{delete, get, post, put},
    Router,
};
use std::path::PathBuf;
use todo_web_server::{db, handlers};
use tower_http::services::{ServeDir, ServeFile};

fn static_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("TODO_WEB_STATIC_DIR") {
        return PathBuf::from(dir);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("web")
        .join("dist")
}

#[tokio::main]
async fn main() -> Result<()> {
    let db_path = db::get_db_path();
    let conn = db::connect()?;
    db::ensure_database(&conn)?;
    drop(conn);
    println!("Database connected: {}", db_path.display());

    let index = static_dir().join("index.html");
    let app = Router::new()
        .route("/api/health", get(|| async { "ok" }))
        .route("/api/projects", get(handlers::get_projects))
        .route("/api/projects", post(handlers::post_project))
        .route("/api/projects/{id}", put(handlers::put_project))
        .route("/api/projects/{id}", delete(handlers::remove_project))
        .route("/api/tasks", get(handlers::get_tasks))
        .route("/api/tasks", post(handlers::post_task))
        .route("/api/tasks/{id}", put(handlers::put_task))
        .route("/api/tasks/{id}", delete(handlers::remove_task))
        .route("/api/stats", get(handlers::get_stats))
        .fallback_service(ServeDir::new(static_dir()).fallback(ServeFile::new(index)));

    let port = std::env::var("PORT")
        .ok()
        .and_then(|port| port.parse::<u16>().ok())
        .unwrap_or(8090);
    let address = format!("0.0.0.0:{port}");
    let listener = tokio::net::TcpListener::bind(&address).await?;

    println!("Server running on http://localhost:{port}");
    axum::serve(listener, app).await?;
    Ok(())
}
