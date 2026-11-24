use anyhow::Result;
use rusqlite::Connection;
use std::path::PathBuf;
use std::time::Duration;

/// Reads `TODO_DB_PATH`; otherwise uses the SUMM-Todo CLI default location.
pub fn get_db_path() -> PathBuf {
    if let Ok(path) = std::env::var("TODO_DB_PATH") {
        return PathBuf::from(path);
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".todo").join("todo.db")
}

pub fn connect() -> Result<Connection> {
    let conn = Connection::open(get_db_path())?;
    conn.busy_timeout(Duration::from_secs(5))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    Ok(conn)
}
