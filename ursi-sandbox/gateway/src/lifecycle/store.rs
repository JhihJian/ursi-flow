//! 单进程独占 SQLite 元数据仓库。副作用前提交操作意图，修订号防止 ABA 写入。
use crate::models::{Error, Result, Sandbox};
use fs2::FileExt;
use rusqlite::{Connection, OptionalExtension, params};
use std::{
    fs::{File, OpenOptions},
    path::Path,
    sync::Mutex,
    time::Duration,
};

pub struct Store {
    connection: Mutex<Connection>,
    _lock: File,
}
fn db_error(error: impl std::fmt::Display) -> Error {
    Error::Internal(format!("metadata: {error}"))
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent).map_err(db_error)?;
        }
        let mut options = OpenOptions::new();
        options.create(true).read(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(path).map_err(db_error)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if file.metadata().map_err(db_error)?.nlink() != 1 {
                return Err(Error::Invalid("数据库不允许硬链接别名".into()));
            }
        }
        let path = std::fs::canonicalize(path).map_err(db_error)?;
        let mut lock_path = path.as_os_str().to_os_string();
        lock_path.push(".lock");
        let lock = options.open(lock_path).map_err(db_error)?;
        lock.try_lock_exclusive()
            .map_err(|_| Error::Conflict("该数据库已有运行中的 Gateway".into()))?;
        let connection = Connection::open(path).map_err(db_error)?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(db_error)?;
        connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS sandboxes (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS creation_keys (key TEXT PRIMARY KEY, sandbox_id TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);").map_err(db_error)?;
        Ok(Self {
            connection: Mutex::new(connection),
            _lock: lock,
        })
    }
    /// 数据库与驱动作用域绑定，阻止默认配置变化把旧记录指向其他资源。
    pub fn bind_identity(&self, identity: &str) -> Result<()> {
        let c = self.connection.lock().map_err(db_error)?;
        let existing: Option<String> = c
            .query_row("SELECT value FROM metadata WHERE key='identity'", [], |r| {
                r.get(0)
            })
            .optional()
            .map_err(db_error)?;
        match existing {
            Some(value) if value != identity => {
                Err(Error::Conflict("数据库驱动/命名空间与配置不一致".into()))
            }
            Some(_) => Ok(()),
            None => {
                c.execute("INSERT INTO metadata VALUES ('identity', ?1)", [identity])
                    .map_err(db_error)?;
                Ok(())
            }
        }
    }
    pub fn get(&self, id: &str) -> Result<Sandbox> {
        let c = self.connection.lock().map_err(db_error)?;
        get_from(&c, id)
    }
    pub fn list(&self) -> Result<Vec<Sandbox>> {
        let c = self.connection.lock().map_err(db_error)?;
        let mut statement = c
            .prepare("SELECT body FROM sandboxes ORDER BY id")
            .map_err(db_error)?;
        let rows = statement
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(db_error)?;
        rows.map(|row| serde_json::from_str(&row.map_err(db_error)?).map_err(db_error))
            .collect()
    }
    pub fn insert(&self, sandbox: &Sandbox, key: Option<&str>) -> Result<Sandbox> {
        let mut c = self.connection.lock().map_err(db_error)?;
        let tx = c.transaction().map_err(db_error)?;
        if let Some(key) = key {
            let existing: Option<String> = tx
                .query_row(
                    "SELECT sandbox_id FROM creation_keys WHERE key=?1",
                    [key],
                    |r| r.get(0),
                )
                .optional()
                .map_err(db_error)?;
            if let Some(id) = existing {
                let old = get_from(&tx, &id).map_err(|error| match error {
                    Error::NotFound(_) => Error::Conflict("该幂等键对应已删除的沙箱".into()),
                    error => error,
                })?;
                return if old.spec == sandbox.spec {
                    Ok(old)
                } else {
                    Err(Error::Conflict("同一幂等键使用了不同规格".into()))
                };
            }
            tx.execute(
                "INSERT INTO creation_keys VALUES (?1, ?2)",
                params![key, sandbox.id],
            )
            .map_err(db_error)?;
        }
        tx.execute(
            "INSERT INTO sandboxes VALUES (?1, ?2, ?3)",
            params![
                sandbox.id,
                sandbox.revision,
                serde_json::to_string(sandbox).map_err(db_error)?
            ],
        )
        .map_err(db_error)?;
        tx.commit().map_err(db_error)?;
        Ok(sandbox.clone())
    }
    pub fn update(&self, sandbox: &mut Sandbox) -> Result<()> {
        let c = self.connection.lock().map_err(db_error)?;
        let old = sandbox.revision;
        let mut updated = sandbox.clone();
        updated.revision = old
            .checked_add(1)
            .ok_or_else(|| Error::Internal("revision overflow".into()))?;
        let rows = c
            .execute(
                "UPDATE sandboxes SET revision=?1, body=?2 WHERE id=?3 AND revision=?4",
                params![
                    updated.revision,
                    serde_json::to_string(&updated).map_err(db_error)?,
                    updated.id,
                    old
                ],
            )
            .map_err(db_error)?;
        if rows != 1 {
            return Err(Error::Conflict("过期元数据修订号".into()));
        }
        *sandbox = updated;
        Ok(())
    }
    pub fn delete(&self, sandbox: &Sandbox) -> Result<()> {
        let c = self.connection.lock().map_err(db_error)?;
        let rows = c
            .execute(
                "DELETE FROM sandboxes WHERE id=?1 AND revision=?2",
                params![sandbox.id, sandbox.revision],
            )
            .map_err(db_error)?;
        if rows != 1 {
            return Err(Error::Conflict("过期删除修订号".into()));
        }
        Ok(())
    }
}
fn get_from(c: &Connection, id: &str) -> Result<Sandbox> {
    let body: Option<String> = c
        .query_row("SELECT body FROM sandboxes WHERE id=?1", [id], |r| r.get(0))
        .optional()
        .map_err(db_error)?;
    serde_json::from_str(&body.ok_or_else(|| Error::NotFound(id.into()))?).map_err(db_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{Operation, Resource, Status};

    fn sandbox(id: &str) -> Sandbox {
        Sandbox {
            id: id.into(),
            spec: serde_json::from_value(serde_json::json!({"image": "alpine:3.22"})).unwrap(),
            resource: Resource {
                generation: 1,
                data_generation: 1,
            },
            status: Status::Preparing,
            operation: Some(Operation::Create),
            retired: vec![],
            revision: 1,
            endpoints: vec![],
            error: None,
        }
    }

    fn setup() -> (tempfile::TempDir, Store, Sandbox) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("metadata.sqlite")).unwrap();
        let original = store
            .insert(&sandbox("original"), Some("request-one"))
            .unwrap();
        (dir, store, original)
    }

    fn assert_no_replacement(store: &Store, original: &Sandbox) {
        assert!(matches!(store.get("replacement"), Err(Error::NotFound(_))));
        let id: String = store
            .connection
            .lock()
            .unwrap()
            .query_row(
                "SELECT sandbox_id FROM creation_keys WHERE key=?1",
                ["request-one"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(id, original.id);
    }

    #[test]
    fn deleted_idempotency_key_remains_conflict() {
        let (_dir, store, original) = setup();
        store.delete(&original).unwrap();

        assert!(matches!(
            store.insert(&sandbox("replacement"), Some("request-one")),
            Err(Error::Conflict(message)) if message == "该幂等键对应已删除的沙箱"
        ));
        assert_no_replacement(&store, &original);
        assert!(store.list().unwrap().is_empty());
    }

    #[test]
    fn corrupt_idempotent_record_is_internal_without_replacement() {
        let (_dir, store, original) = setup();
        store
            .connection
            .lock()
            .unwrap()
            .execute(
                "UPDATE sandboxes SET body=?1 WHERE id=?2",
                params!["{broken-json", original.id],
            )
            .unwrap();

        assert!(matches!(
            store.insert(&sandbox("replacement"), Some("request-one")),
            Err(Error::Internal(_))
        ));
        assert_no_replacement(&store, &original);
        let body: String = store
            .connection
            .lock()
            .unwrap()
            .query_row(
                "SELECT body FROM sandboxes WHERE id=?1",
                [&original.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(body, "{broken-json");
    }

    #[test]
    fn idempotent_record_query_failure_remains_internal() {
        let (_dir, store, original) = setup();
        // 保留幂等键查询，只让随后读取沙箱记录的 SQL 失败。
        store
            .connection
            .lock()
            .unwrap()
            .execute_batch("ALTER TABLE sandboxes RENAME TO unavailable_sandboxes")
            .unwrap();

        assert!(matches!(
            store.insert(&sandbox("replacement"), Some("request-one")),
            Err(Error::Internal(message)) if message.contains("no such table: sandboxes")
        ));

        store
            .connection
            .lock()
            .unwrap()
            .execute_batch("ALTER TABLE unavailable_sandboxes RENAME TO sandboxes")
            .unwrap();
        assert_no_replacement(&store, &original);
        assert_eq!(store.get(&original.id).unwrap().revision, original.revision);
        assert_eq!(store.list().unwrap().len(), 1);
    }
}
