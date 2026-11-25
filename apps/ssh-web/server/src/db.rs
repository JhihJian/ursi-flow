use anyhow::{Context, Result};
use rusqlite::{params, Connection as Db, Row};
use std::path::PathBuf;

use crate::models::{local_connection, Connection, ConnectionKind, LOCAL_CONNECTION_ID};

/// 数据根目录，默认 `~/.ursi`，可用 `URSI_DATA_DIR` 指向其它位置。
pub fn data_root() -> PathBuf {
    if let Some(dir) = std::env::var_os("URSI_DATA_DIR") {
        return PathBuf::from(dir);
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".ursi")
}

/// 连接库目录：数据根目录下的 `ssh`。
pub fn default_data_dir() -> PathBuf {
    data_root().join("ssh")
}

/// 读 `SSH_DB_PATH`；否则用 `<数据根目录>/ssh/ssh.db`。
pub fn get_db_path() -> PathBuf {
    if let Ok(path) = std::env::var("SSH_DB_PATH") {
        return PathBuf::from(path);
    }
    default_data_dir().join("ssh.db")
}

pub fn connect() -> Result<Db> {
    let path = get_db_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let conn = Db::open(&path).with_context(|| format!("打开连接库失败：{}", path.display()))?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    Ok(conn)
}

/// 连接配置是本服务自建自管的数据，启动时直接建表。
/// 已存在的库不迁移：schema 变化时删除库文件重建即可。
pub fn ensure_database(conn: &Db) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS connections (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            command TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );",
    )?;
    Ok(())
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn row_to_connection(row: &Row) -> rusqlite::Result<Connection> {
    Ok(Connection {
        id: row.get("id")?,
        name: row.get("name")?,
        command: row.get("command")?,
        kind: ConnectionKind::Ssh,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

const CONNECTION_COLUMNS: &str = "id, name, command, created_at, updated_at";

/// 连接列表：首项固定为虚拟本机连接（id 0，不入库），后面是按名称排序的用户连接。
/// 用户若手动建了同名的本机连接，则不重复出现。
pub fn list_connections(conn: &Db) -> Result<Vec<Connection>> {
    let sql = format!("SELECT {CONNECTION_COLUMNS} FROM connections ORDER BY name COLLATE NOCASE");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], row_to_connection)?;
    let mut connections: Vec<Connection> = rows.collect::<Result<Vec<_>, _>>()?;
    let has_local_entry = connections
        .iter()
        .any(|connection| connection.name == local_connection().name);
    if !has_local_entry {
        connections.insert(0, local_connection());
    }
    Ok(connections)
}

/// 取连接：id 0 为虚拟本机连接，其余查库。
pub fn get_connection(conn: &Db, id: i64) -> Result<Option<Connection>> {
    if id == LOCAL_CONNECTION_ID {
        return Ok(Some(local_connection()));
    }
    let sql = format!("SELECT {CONNECTION_COLUMNS} FROM connections WHERE id = ?1");
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query_map(params![id], row_to_connection)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

pub fn get_connection_by_name(conn: &Db, name: &str) -> Result<Option<Connection>> {
    if name == local_connection().name {
        return Ok(Some(local_connection()));
    }
    let sql = format!("SELECT {CONNECTION_COLUMNS} FROM connections WHERE name = ?1");
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query_map(params![name], row_to_connection)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

pub fn insert_connection(conn: &Db, name: &str, command: &str) -> Result<i64> {
    let now = now();
    conn.execute(
        "INSERT INTO connections (name, command, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)",
        params![name, command, now, now],
    )?;
    Ok(conn.last_insert_rowid())
}

/// 更新连接。`None` 表示不改；命令更新时已在上层校验。
pub fn update_connection(conn: &Db, id: i64, name: Option<&str>, command: Option<&str>) -> Result<bool> {
    let Some(existing) = get_connection(conn, id)? else {
        return Ok(false);
    };
    let name = name
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&existing.name);
    let command = command.map(str::trim).filter(|s| !s.is_empty()).unwrap_or(&existing.command);
    let changed = conn.execute(
        "UPDATE connections SET name = ?1, command = ?2, updated_at = ?3 WHERE id = ?4",
        params![name, command, now(), id],
    )?;
    Ok(changed > 0)
}

pub fn delete_connection(conn: &Db, id: i64) -> Result<bool> {
    let changed = conn.execute("DELETE FROM connections WHERE id = ?1", params![id])?;
    Ok(changed > 0)
}
