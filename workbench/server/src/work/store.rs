use super::Error;
use serde_json::{Value, json};
use std::{
    fs::{self, DirBuilder, File, OpenOptions},
    io::{self, BufReader, BufWriter, Write},
    os::{
        fd::AsRawFd,
        unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
    },
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use uuid::Uuid;

mod legacy;
#[cfg(test)]
mod tests;

#[derive(Clone)]
pub(super) struct Store(Arc<Inner>);
struct Inner {
    dir: PathBuf,
    // None: rename succeeded but directory sync failed. Only open() can recover.
    db: Mutex<Option<Value>>,
    _lock: File,
}

fn unavailable() -> Error {
    Error::Unavailable("工作存储已停止读写，请检查存储后重启服务".into())
}

// serde_json's default reader rejects the 128th open array or object,
// including an empty one. Count the database root as a container too.
const MAX_CONTAINERS: usize = 127;
fn fits_reader(value: &Value, remaining: usize) -> bool {
    match value {
        Value::Array(a) => remaining > 0 && a.iter().all(|v| fits_reader(v, remaining - 1)),
        Value::Object(o) => remaining > 0 && o.values().all(|v| fits_reader(v, remaining - 1)),
        _ => true,
    }
}

impl Store {
    pub(super) fn dir(&self) -> &Path {
        &self.0.dir
    }

    pub fn open(dir: PathBuf) -> io::Result<Self> {
        DirBuilder::new().recursive(true).mode(0o700).create(&dir)?;
        if fs::symlink_metadata(&dir)?.file_type().is_symlink()
            || dir.metadata()?.permissions().mode() & 0o077 != 0
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "工作数据目录必须为服务账户私有目录",
            ));
        }
        // Subprocesses receive paths derived from the store. Keep them absolute so
        // they cannot be reinterpreted relative to an executor's workspace.
        let dir = fs::canonicalize(dir)?;
        let lock = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(dir.join("work.lock"))?;
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let db: Value = match File::open(dir.join("work.json")) {
            Ok(f) => serde_json::from_reader(BufReader::new(f))?,
            Err(e) if e.kind() == io::ErrorKind::NotFound => json!({}),
            Err(e) => return Err(e),
        };
        if !db.is_object() {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "无效的工作数据"));
        }
        let retire_dispatch = legacy::present(&db);
        let split_categories = db["workListItems"]
            .as_object()
            .is_some_and(|rows| rows.values().any(|row| row.get("status").is_none()));
        let store = Self(Arc::new(Inner {
            dir,
            db: Mutex::new(Some(db)),
            _lock: lock,
        }));
        if retire_dispatch || split_categories {
            store
                .update(|db| {
                    if split_categories {
                        legacy::split_categories(db)?;
                    }
                    if retire_dispatch {
                        legacy::retire(store.dir(), db)
                            .map_err(|e| Error::Internal(e.to_string()))?;
                    }
                    Ok(())
                })
                .map_err(|e| io::Error::other(format!("工作数据升级失败：{e:?}")))?;
        }
        Ok(store)
    }

    pub fn read<T>(&self, f: impl FnOnce(&Value) -> Result<T, Error>) -> Result<T, Error> {
        let db = self.0.db.lock().map_err(|_| unavailable())?;
        f(db.as_ref().ok_or_else(unavailable)?)
    }

    pub fn update<T>(&self, f: impl FnOnce(&mut Value) -> Result<T, Error>) -> Result<T, Error> {
        self.update_with_dir_sync(f, |dir| File::open(dir)?.sync_all())
    }

    fn update_with_dir_sync<T>(
        &self,
        f: impl FnOnce(&mut Value) -> Result<T, Error>,
        sync_dir: impl FnOnce(&Path) -> io::Result<()>,
    ) -> Result<T, Error> {
        let mut state = self.0.db.lock().map_err(|_| unavailable())?;
        let db = state.as_ref().ok_or_else(unavailable)?;
        let mut next = db.clone();
        let result = f(&mut next)?;
        if next == *db {
            return Ok(result);
        }
        if !next.is_object() {
            return Err(Error::Invalid("无效的工作数据".into()));
        }
        if !fits_reader(&next, MAX_CONTAINERS) {
            return Err(Error::Invalid("工作数据嵌套层数超出可恢复上限".into()));
        }
        self.replace_file(&next)
            .map_err(|e| Error::Internal(e.to_string()))?;
        if let Err(e) = sync_dir(&self.0.dir) {
            // Neither snapshot can safely be served or used as a basis for new writes.
            *state = None;
            eprintln!("工作存储：工作数据已替换，但目录同步失败：{e}");
            return Err(unavailable());
        }
        *state = Some(next);
        Ok(result)
    }

    fn replace_file(&self, next: &Value) -> io::Result<()> {
        let tmp = self.0.dir.join(format!(".{}.tmp", Uuid::new_v4()));
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)?;
        let publish = (|| {
            let mut writer = BufWriter::new(file);
            serde_json::to_writer(&mut writer, next)?;
            writer.flush()?;
            writer.get_ref().sync_all()?;
            fs::rename(&tmp, self.0.dir.join("work.json"))
        })();
        if publish.is_err() {
            let _ = fs::remove_file(tmp);
        }
        publish
    }
}
