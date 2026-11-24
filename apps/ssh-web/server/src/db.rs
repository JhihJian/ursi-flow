use anyhow::{Context, Result};
use rusqlite::{params, Connection as Db, Row};
use std::path::PathBuf;

use crate::models::AuthType;
pub use crate::models::Connection;

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
            host TEXT NOT NULL,
            port INTEGER NOT NULL DEFAULT 22,
            username TEXT NOT NULL,
            auth_type TEXT NOT NULL CHECK (auth_type IN ('password', 'key')),
            password TEXT,
            key_path TEXT,
            key_passphrase TEXT,
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
    let auth_type: String = row.get("auth_type")?;
    Ok(Connection {
        id: row.get("id")?,
        name: row.get("name")?,
        host: row.get("host")?,
        port: row.get("port")?,
        username: row.get("username")?,
        auth_type: match auth_type.as_str() {
            "key" => AuthType::Key,
            _ => AuthType::Password,
        },
        password: row.get("password")?,
        key_path: row.get("key_path")?,
        key_passphrase: row.get("key_passphrase")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

const CONNECTION_COLUMNS: &str =
    "id, name, host, port, username, auth_type, password, key_path, key_passphrase, created_at, updated_at";

pub fn list_connections(conn: &Db) -> Result<Vec<Connection>> {
    let sql = format!("SELECT {CONNECTION_COLUMNS} FROM connections ORDER BY name COLLATE NOCASE");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], row_to_connection)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn get_connection_by_name(conn: &Db, name: &str) -> Result<Option<Connection>> {
    let sql = format!("SELECT {CONNECTION_COLUMNS} FROM connections WHERE name = ?1");
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query_map(params![name], row_to_connection)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

pub fn get_connection(conn: &Db, id: i64) -> Result<Option<Connection>> {
    let sql = format!("SELECT {CONNECTION_COLUMNS} FROM connections WHERE id = ?1");
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query_map(params![id], row_to_connection)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

pub fn insert_connection(conn: &Db, fields: &NewConnection) -> Result<i64> {
    let now = now();
    conn.execute(
        "INSERT INTO connections (name, host, port, username, auth_type, password, key_path, key_passphrase, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            fields.name,
            fields.host,
            fields.port,
            fields.username,
            fields.auth_type.as_str(),
            fields.password,
            fields.key_path,
            fields.key_passphrase,
            now,
            now
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

/// 新建连接的落库字段。`Connection` 含 id 与时间戳，新建前还没有。
pub struct NewConnection<'a> {
    pub name: &'a str,
    pub host: &'a str,
    pub port: i64,
    pub username: &'a str,
    pub auth_type: AuthType,
    pub password: Option<&'a str>,
    pub key_path: Option<&'a str>,
    pub key_passphrase: Option<&'a str>,
}

/// 更新的字段集合：`None` 表示不改，`Some(None)` 表示清空。
/// 密码列是否保留由 `password_keep` 单独控制。
pub struct ConnectionUpdate<'a> {
    pub name: Option<&'a str>,
    pub host: Option<&'a str>,
    pub port: Option<i64>,
    pub username: Option<&'a str>,
    pub auth_type: Option<AuthType>,
    pub password_keep: bool,
    pub password: Option<&'a str>,
    pub key_path: Option<Option<&'a str>>,
    pub key_passphrase: Option<Option<&'a str>>,
}

/// 更新连接。`password_keep` 为真时不动密码列，其余字段传 `None` 表示不改。
pub fn update_connection(conn: &Db, id: i64, update: &ConnectionUpdate) -> Result<bool> {
    let Some(existing) = get_connection(conn, id)? else {
        return Ok(false);
    };
    let name = update
        .name
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .unwrap_or(existing.name);
    let host = update
        .host
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .unwrap_or(existing.host);
    let port = update.port.unwrap_or(existing.port);
    let username = update
        .username
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .unwrap_or(existing.username);
    let auth_type = update.auth_type.unwrap_or(existing.auth_type);
    let password = if update.password_keep {
        existing.password
    } else {
        update.password.map(String::from)
    };
    let key_path = update
        .key_path
        .map(|value| {
            value
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        })
        .unwrap_or(existing.key_path);
    let key_passphrase = update
        .key_passphrase
        .map(|value| {
            value
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        })
        .unwrap_or(existing.key_passphrase);

    let changed = conn.execute(
        "UPDATE connections SET name = ?1, host = ?2, port = ?3, username = ?4, auth_type = ?5, password = ?6, key_path = ?7, key_passphrase = ?8, updated_at = ?9 WHERE id = ?10",
        params![name, host, port, username, auth_type.as_str(), password, key_path, key_passphrase, now(), id],
    )?;
    Ok(changed > 0)
}

pub fn delete_connection(conn: &Db, id: i64) -> Result<bool> {
    let changed = conn.execute("DELETE FROM connections WHERE id = ?1", params![id])?;
    Ok(changed > 0)
}

impl AuthType {
    pub fn as_str(self) -> &'static str {
        match self {
            AuthType::Password => "password",
            AuthType::Key => "key",
        }
    }
}
