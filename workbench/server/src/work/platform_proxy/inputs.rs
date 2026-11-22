//! 用工作包记录定位输入。首次 PUT 在本地冻结快照，丢回执或重启后仍能重发原输入。
use super::{Error, Store, directories};
use base64::{Engine, engine::general_purpose::STANDARD};
use rustix::{
    fd::{AsRawFd, OwnedFd},
    fs::{self as at, Dir, FileType, Mode, OFlags, ResolveFlags},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, BufReader, BufWriter, Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
};
use uuid::Uuid;

const ENTRIES: usize = 4096;
const TOTAL: usize = 64 * 1024 * 1024;
const WITHIN: ResolveFlags = ResolveFlags::BENEATH
    .union(ResolveFlags::NO_SYMLINKS)
    .union(ResolveFlags::NO_XDEV);
fn invalid() -> Error {
    Error::Invalid("工作包输入含不支持的条目、发生变动或超过快照上限".into())
}
fn failed() -> Error {
    Error::Internal("无法保存或读取工作包输入快照".into())
}

// store 锁与目录写入共用。固定源 inode 后检查类型，不跟随链接，不读取设备、FIFO 或硬链接。
fn collect(
    dir: &OwnedFd,
    prefix: &str,
    entries: &mut Vec<Value>,
    remaining: &mut usize,
) -> Result<(), Error> {
    let before = at::fstat(dir).map_err(|_| invalid())?;
    for entry in Dir::read_from(dir).map_err(|_| invalid())? {
        let entry = entry.map_err(|_| invalid())?;
        let name = entry.file_name().to_str().map_err(|_| invalid())?;
        if matches!(name, "." | "..") {
            continue;
        }
        let path = if prefix.is_empty() {
            name.to_owned()
        } else {
            format!("{prefix}/{name}")
        };
        directories::fs::segments(&path, false)?;
        if entries.len() >= ENTRIES {
            return Err(invalid());
        }
        let pin = at::openat2(
            dir,
            name,
            OFlags::PATH | OFlags::CLOEXEC,
            Mode::empty(),
            WITHIN,
        )
        .map_err(|_| invalid())?;
        let stat = at::fstat(&pin).map_err(|_| invalid())?;
        match FileType::from_raw_mode(stat.st_mode) {
            FileType::Directory => {
                let child = at::openat2(
                    &pin,
                    ".",
                    OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
                    Mode::empty(),
                    WITHIN,
                )
                .map_err(|_| invalid())?;
                entries.push(json!({"kind":"dir", "path":path}));
                collect(&child, &path, entries, remaining)?;
            }
            FileType::RegularFile if stat.st_nlink == 1 => {
                let size = usize::try_from(stat.st_size).map_err(|_| invalid())?;
                if size > *remaining || size > directories::fs::FILE_LIMIT as usize {
                    return Err(invalid());
                }
                let mut bytes = Vec::with_capacity(size);
                File::open(format!("/proc/self/fd/{}", pin.as_raw_fd()))
                    .map_err(|_| invalid())?
                    .take(size as u64 + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|_| invalid())?;
                if bytes.len() != size {
                    return Err(invalid());
                }
                *remaining -= size;
                entries.push(
                    json!({"kind":"file", "path":path, "contentBase64":STANDARD.encode(bytes)}),
                );
            }
            _ => return Err(invalid()),
        }
        let end = at::fstat(&pin).map_err(|_| invalid())?;
        if (end.st_ctime, end.st_ctime_nsec) != (stat.st_ctime, stat.st_ctime_nsec) {
            return Err(invalid());
        }
    }
    let end = at::fstat(dir).map_err(|_| invalid())?;
    if (end.st_ctime, end.st_ctime_nsec) != (before.st_ctime, before.st_ctime_nsec) {
        return Err(invalid());
    }
    Ok(())
}

pub(super) fn snapshot(store: &Store, origin: &str, id: &str, patch: &str) -> Result<Value, Error> {
    let key = Sha256::digest(format!("{origin}\0{id}").as_bytes());
    let cached = store.dir().join(format!(".platform-inputs-{key:x}.json"));
    store.read(|db| {
        match OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(&cached)
        {
            Ok(file) => {
                let meta = file.metadata().map_err(|_| failed())?;
                if !meta.is_file()
                    || meta.nlink() != 1
                    || meta.mode() & 0o077 != 0
                    || meta.len() > 128 * 1024 * 1024
                {
                    return Err(failed());
                }
                let (original, inputs): (String, Value) =
                    serde_json::from_reader(BufReader::new(file)).map_err(|_| failed())?;
                return if original == patch {
                    Ok(inputs)
                } else {
                    Err(Error::Conflict("同一尝试 ID 已绑定其他工作包".into()))
                };
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => (),
            Err(_) => return Err(failed()),
        }
        let record = db["workPatches"]
            .get(patch)
            .ok_or_else(|| Error::NotFound("工作包不存在".into()))?;
        if record["id"] != patch {
            return Err(failed());
        }
        let ident = record["directoryId"].as_str().ok_or_else(failed)?;
        let root = directories::registered_root(store.dir(), db, ident)?;
        let parent = at::openat2(
            at::CWD,
            root.parent().ok_or_else(failed)?,
            OFlags::PATH | OFlags::DIRECTORY | OFlags::CLOEXEC,
            Mode::empty(),
            ResolveFlags::NO_SYMLINKS,
        )
        .map_err(|_| failed())?;
        let dir = at::openat2(
            parent,
            ident,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
            Mode::empty(),
            WITHIN,
        )
        .map_err(|_| failed())?;
        let mut entries = Vec::new();
        let mut remaining = TOTAL;
        collect(&dir, "", &mut entries, &mut remaining)?;
        entries.sort_unstable_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
        let inputs = Value::Array(entries);
        let tmp = store
            .dir()
            .join(format!(".platform-tmp-{}", Uuid::new_v4()));
        let result = (|| -> io::Result<()> {
            let file = OpenOptions::new()
                .write(true)
                .mode(0o600)
                .create_new(true)
                .open(&tmp)?;
            let mut writer = BufWriter::new(file);
            serde_json::to_writer(&mut writer, &(patch, &inputs))?;
            writer.flush()?;
            writer.get_ref().sync_all()?;
            fs::rename(&tmp, &cached)?;
            File::open(store.dir())?.sync_all()
        })();
        if result.is_err() {
            let _ = fs::remove_file(tmp);
            return Err(failed());
        }
        Ok(inputs)
    })
}
