use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::{self, DirBuilder, File, OpenOptions},
    io::{self, Read, Write},
    os::{
        fd::AsRawFd,
        unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
    },
    path::{Path, PathBuf},
    sync::Mutex,
};
use ursi_mcp::{Credentials, Error, MAX_SERVERS, ServerRecord, ServerRepository, Settings};

const MAX_DATA: usize = 4 * 1024 * 1024;

pub fn open_private(options: &mut OpenOptions, path: &Path) -> io::Result<File> {
    let file = options
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file() || meta.permissions().mode() & 0o077 != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "文件必须为私有普通文件",
        ));
    }
    Ok(file)
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Data {
    servers: BTreeMap<String, ServerRecord>,
    credentials: BTreeMap<String, String>,
}

pub struct Store {
    pub dir: PathBuf,
    data: Mutex<Option<Data>>,
    _lock: File,
}

fn unavailable() -> Error {
    Error::Unavailable("存储不可用，请检查数据目录和磁盘空间".into())
}

impl Store {
    pub fn open(path: &Path) -> io::Result<Self> {
        DirBuilder::new().recursive(true).mode(0o700).create(path)?;
        let meta = fs::symlink_metadata(path)?;
        if !meta.is_dir() || meta.permissions().mode() & 0o077 != 0 {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "数据目录必须为私有目录",
            ));
        }
        let dir = path.canonicalize()?;
        let lock = open_private(
            OpenOptions::new().write(true).create(true).mode(0o600),
            &dir.join("store.lock"),
        )?;
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(io::Error::other("无法锁定数据目录，请检查是否已有实例"));
        }
        let data = match open_private(OpenOptions::new().read(true), &dir.join("store.json")) {
            Ok(file) => {
                let mut bytes = Vec::new();
                file.take((MAX_DATA + 1) as u64).read_to_end(&mut bytes)?;
                if bytes.len() > MAX_DATA {
                    return Err(io::Error::other("数据文件超限"));
                }
                serde_json::from_slice(&bytes).map_err(|_| io::Error::other("数据文件无效"))?
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => Data::default(),
            Err(e) => return Err(e),
        };
        Ok(Self {
            dir,
            data: Mutex::new(Some(data)),
            _lock: lock,
        })
    }
    fn read<T>(&self, f: impl FnOnce(&Data) -> T) -> Result<T, Error> {
        let data = self.data.lock().map_err(|_| unavailable())?;
        Ok(f(data.as_ref().ok_or_else(unavailable)?))
    }
    fn update<T>(&self, f: impl FnOnce(&mut Data) -> Result<T, Error>) -> Result<T, Error> {
        let mut guard = self.data.lock().map_err(|_| unavailable())?;
        let mut data = guard.as_ref().ok_or_else(unavailable)?.clone();
        let result = f(&mut data)?;
        let bytes = serde_json::to_vec(&data).map_err(|_| unavailable())?;
        if bytes.len() > MAX_DATA {
            return Err(Error::Invalid("数据文件超限".into()));
        }
        let mut file = tempfile::NamedTempFile::new_in(&self.dir).map_err(|_| unavailable())?;
        file.write_all(&bytes)
            .and_then(|_| file.as_file().sync_all())
            .map_err(|_| unavailable())?;
        file.persist(self.dir.join("store.json"))
            .map_err(|_| unavailable())?;
        if File::open(&self.dir).and_then(|f| f.sync_all()).is_err() {
            // Once renamed, fail closed rather than writing from a possibly stale snapshot.
            *guard = None;
            return Err(unavailable());
        }
        *guard = Some(data);
        Ok(result)
    }

    pub fn names(&self) -> Result<Vec<String>, Error> {
        self.read(|d| d.credentials.keys().cloned().collect())
    }
    pub fn set_credential(
        &self,
        name: String,
        value: String,
        replace: bool,
    ) -> Result<Result<(), axum::http::StatusCode>, Error> {
        use axum::http::StatusCode;
        if !ursi_mcp::valid_credential_name(&name)
            || value.is_empty()
            || value.len() > 8192
            || value.contains('\0')
        {
            return Err(Error::Invalid("变量名称或值无效".into()));
        }
        self.update(|d| match (d.credentials.contains_key(&name), replace) {
            (true, false) => Ok(Err(StatusCode::CONFLICT)),
            (false, true) => Ok(Err(StatusCode::NOT_FOUND)),
            (false, false) if d.credentials.len() >= 128 => {
                Err(Error::Invalid("最多保存 128 个变量".into()))
            }
            _ => {
                d.credentials.insert(name, value);
                Ok(Ok(()))
            }
        })
    }
    pub fn remove_credential(&self, name: &str) -> Result<bool, Error> {
        self.update(|d| Ok(d.credentials.remove(name).is_some()))
    }
}

impl Credentials for Store {
    fn lookup(&self, name: &str) -> Result<Option<String>, Error> {
        self.read(|d| d.credentials.get(name).cloned())
    }
}
impl ServerRepository for Store {
    fn list(&self) -> Result<Vec<ServerRecord>, Error> {
        self.read(|d| d.servers.values().cloned().collect())
    }
    fn get(&self, id: &str) -> Result<Option<ServerRecord>, Error> {
        self.read(|d| d.servers.get(id).cloned())
    }
    fn insert(&self, row: &ServerRecord) -> Result<(), Error> {
        self.update(|d| {
            if d.servers.len() >= MAX_SERVERS {
                return Err(Error::Invalid("最多登记 128 个 MCP 服务".into()));
            }
            d.servers.insert(row.id.clone(), row.clone());
            Ok(())
        })
    }
    fn remove(&self, id: &str) -> Result<bool, Error> {
        self.update(|d| Ok(d.servers.remove(id).is_some()))
    }
    fn replace_settings(&self, id: &str, settings: &Settings) -> Result<bool, Error> {
        self.update(|d| {
            let Some(record) = d.servers.get_mut(id) else {
                return Ok(false);
            };
            record.config.settings = Some(settings.clone());
            Ok(true)
        })
    }
}
