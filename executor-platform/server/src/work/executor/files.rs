//! 每次尝试独享工作区。目录记录与结果一起提交，执行器从不持有冻结目录的路径。
use crate::work::{Error, Store, directories};
use base64::{Engine, engine::general_purpose::STANDARD};
use rustix::{
    fd::{AsRawFd, OwnedFd},
    fs::{self, AtFlags, Dir, FileType, Mode, OFlags, ResolveFlags},
    io::Errno,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    ffi::CStr,
    fs::File,
    io::{self, Read, Write},
    path::Path,
};

const TOTAL_LIMIT: u64 = 64 * 1024 * 1024;
const ENTRY_LIMIT: usize = 4096;
const DIR: OFlags = OFlags::RDONLY
    .union(OFlags::DIRECTORY)
    .union(OFlags::CLOEXEC);
const WITHIN: ResolveFlags = ResolveFlags::BENEATH
    .union(ResolveFlags::NO_SYMLINKS)
    .union(ResolveFlags::NO_XDEV);

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}
fn file_error(e: io::Error) -> Error {
    if e.kind() == io::ErrorKind::InvalidData {
        Error::Invalid("目录含有不支持的条目、路径或超过复制限额".into())
    } else {
        Error::Internal("执行工作区文件操作失败".into())
    }
}
fn key(s: &str) -> Result<(), Error> {
    if directories::fs::segments(s, false)?.len() != 1 {
        return Err(Error::Invalid("标识必须是单个名称段".into()));
    }
    Ok(())
}
fn host_dir(path: &Path) -> io::Result<OwnedFd> {
    Ok(fs::openat2(
        fs::CWD,
        path,
        DIR,
        Mode::empty(),
        ResolveFlags::NO_SYMLINKS,
    )?)
}
fn subdir(parent: &OwnedFd, name: impl rustix::path::Arg) -> io::Result<OwnedFd> {
    Ok(fs::openat2(parent, name, DIR, Mode::empty(), WITHIN)?)
}
fn private(fd: OwnedFd) -> io::Result<OwnedFd> {
    if fs::fstat(&fd)?.st_mode & 0o077 != 0 {
        return Err(invalid("目录必须私有"));
    }
    Ok(fd)
}
fn root_dir(root: &Path, create: bool) -> io::Result<OwnedFd> {
    let parent = host_dir(
        root.parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new(".")),
    )?;
    let name = root.file_name().ok_or_else(|| invalid("缺少目录名"))?;
    if create {
        match fs::mkdirat(&parent, name, Mode::RWXU) {
            Ok(()) => fs::fsync(&parent)?,
            Err(Errno::EXIST) => (),
            Err(e) => return Err(e.into()),
        }
    }
    private(subdir(&parent, name)?)
}
fn mkdir(parent: &OwnedFd, name: &str) -> io::Result<OwnedFd> {
    fs::mkdirat(parent, name, Mode::RWXU)?;
    subdir(parent, name)
}

// 只在确认未登记时清理孤儿。unlink 不跟随链接，不修改硬链接文件权限；禁止跨挂载点递归。
fn discard(parent: &OwnedFd, name: &CStr, depth: usize, remaining: &mut usize) -> io::Result<()> {
    if depth > 40 || *remaining == 0 {
        return Err(invalid("孤儿目录超过清理上限"));
    }
    *remaining -= 1;
    let st = fs::statat(parent, name, AtFlags::SYMLINK_NOFOLLOW)?;
    let flags = if FileType::from_raw_mode(st.st_mode) == FileType::Directory {
        let dir = subdir(parent, name)?;
        for entry in Dir::read_from(&dir)? {
            let entry = entry?;
            let child = entry.file_name();
            if !matches!(child.to_bytes(), b"." | b"..") {
                discard(&dir, child, depth + 1, remaining)?;
            }
        }
        AtFlags::REMOVEDIR
    } else {
        AtFlags::empty()
    };
    Ok(fs::unlinkat(parent, name, flags)?)
}

#[derive(Default)]
struct Budget {
    entries: usize,
    bytes: u64,
}

impl Budget {
    fn copy_tree(&mut self, src: &OwnedFd, dst: &OwnedFd, prefix: &str) -> io::Result<()> {
        let before = fs::fstat(src)?;
        for entry in Dir::read_from(src)? {
            let entry = entry?;
            let name = entry.file_name();
            if matches!(name.to_bytes(), b"." | b"..") {
                continue;
            }
            let name = name.to_str().map_err(|_| invalid("无效文件名"))?;
            let path = if prefix.is_empty() {
                name.to_owned()
            } else {
                format!("{prefix}/{name}")
            };
            // 复用目录 API 的保留名、路径长度及深度上限，确保每个已发布条目可寻址。
            directories::fs::segments(&path, false).map_err(|_| invalid("无效相对路径"))?;
            self.entries += 1;
            if self.entries > ENTRY_LIMIT {
                return Err(invalid("条目过多"));
            }
            // 先固定 inode 再判断类型。O_PATH 不会实际打开设备或堵在 FIFO 上。
            let pin = fs::openat2(
                src,
                name,
                OFlags::PATH | OFlags::CLOEXEC,
                Mode::empty(),
                WITHIN,
            )?;
            let st = fs::fstat(&pin)?;
            match FileType::from_raw_mode(st.st_mode) {
                FileType::Directory => {
                    self.copy_tree(&subdir(&pin, ".")?, &mkdir(dst, name)?, &path)?
                }
                FileType::RegularFile if st.st_nlink == 1 => {
                    let limit = directories::fs::FILE_LIMIT.min(TOTAL_LIMIT - self.bytes);
                    let size = u64::try_from(st.st_size).map_err(|_| invalid("文件大小无效"))?;
                    if size > limit {
                        return Err(invalid("文件超过复制限额"));
                    }
                    let input = File::open(format!("/proc/self/fd/{}", pin.as_raw_fd()))?;
                    let mut output = File::from(fs::openat2(
                        dst,
                        name,
                        OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::CLOEXEC,
                        Mode::RUSR | Mode::WUSR,
                        WITHIN,
                    )?);
                    let copied = io::copy(&mut input.take(size + 1), &mut output)?;
                    if copied != size || !unchanged(&st, &fs::fstat(&pin)?) {
                        return Err(invalid("复制期间文件有变动"));
                    }
                    self.bytes += copied;
                    output.sync_all()?;
                }
                _ => return Err(invalid("不支持链接或特殊文件")),
            }
        }
        if !unchanged(&before, &fs::fstat(src)?) {
            return Err(invalid("复制期间目录有变动"));
        }
        Ok(fs::fsync(dst)?)
    }
}
fn unchanged(a: &fs::Stat, b: &fs::Stat) -> bool {
    (a.st_ctime, a.st_ctime_nsec, a.st_nlink, a.st_size)
        == (b.st_ctime, b.st_ctime_nsec, b.st_nlink, b.st_size)
}

fn patch_dir(store: &Store, db: &Value, id: &str) -> Result<OwnedFd, Error> {
    let patch = db["workPatches"]
        .get(id)
        .ok_or_else(|| Error::NotFound("工作包不存在".into()))?;
    let corrupt = || Error::Internal("工作包目录引用无效".into());
    let dir = patch["directoryId"].as_str().ok_or_else(corrupt)?;
    key(dir).map_err(|_| corrupt())?;
    if patch["id"] != id || db["directories"][dir]["id"] != dir {
        return Err(corrupt());
    }
    host_dir(&store.dir().join(directories::fs::ROOT))
        .and_then(private)
        .and_then(|base| subdir(&base, dir))
        .and_then(private)
        .map_err(file_error)
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub(super) enum Input {
    Dir {
        path: String,
    },
    File {
        path: String,
        #[serde(rename = "contentBase64")]
        content: String,
    },
}
impl Input {
    fn path(&self) -> &str {
        match self {
            Self::Dir { path } | Self::File { path, .. } => path,
        }
    }
}

/// Flat, explicit manifest. Sorting places each parent before its children and stabilizes retries.
pub(super) fn input_digest(entries: &mut [Input]) -> Result<String, Error> {
    if entries.len() > ENTRY_LIMIT {
        return Err(Error::Invalid("输入条目过多".into()));
    }
    entries.sort_unstable_by(|a, b| a.path().cmp(b.path()));
    let mut digest = Sha256::new();
    let mut prev = None;
    let mut total = 0;
    let mut dirs = std::collections::HashSet::new();
    for entry in entries.iter() {
        directories::fs::segments(entry.path(), false)?;
        if prev == Some(entry.path()) {
            return Err(Error::Invalid("输入路径重复".into()));
        }
        if let Some((parent, _)) = entry.path().rsplit_once('/') {
            if !dirs.contains(parent) {
                return Err(Error::Invalid("输入条目缺少父目录".into()));
            }
        }
        prev = Some(entry.path());
        digest.update((entry.path().len() as u64).to_le_bytes());
        digest.update(entry.path());
        match entry {
            Input::Dir { path } => {
                dirs.insert(path.as_str());
                digest.update([0]);
            }
            Input::File { content, .. } => {
                if content.len() > directories::fs::FILE_LIMIT.div_ceil(3) as usize * 4 {
                    return Err(Error::Invalid("输入文件过大".into()));
                }
                let data = STANDARD
                    .decode(content)
                    .map_err(|_| Error::Invalid("输入文件编码无效".into()))?;
                total += data.len() as u64;
                if data.len() as u64 > directories::fs::FILE_LIMIT || total > TOTAL_LIMIT {
                    return Err(Error::Invalid("输入文件超过复制限额".into()));
                }
                digest.update([1]);
                digest.update((data.len() as u64).to_le_bytes());
                digest.update(data);
            }
        }
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn import(entries: &[Input], inputs: &OwnedFd) -> io::Result<()> {
    for entry in entries {
        let (parent, name) = entry.path().rsplit_once('/').unwrap_or((".", entry.path()));
        let dir = subdir(inputs, parent).map_err(|_| invalid("输入条目缺少父目录"))?;
        match entry {
            Input::Dir { .. } => {
                mkdir(&dir, name)?;
            }
            Input::File { content, .. } => {
                let data = STANDARD
                    .decode(content)
                    .map_err(|_| invalid("输入文件编码无效"))?;
                let mut f = File::from(fs::openat2(
                    &dir,
                    name,
                    OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::CLOEXEC,
                    Mode::RUSR | Mode::WUSR,
                    WITHIN,
                )?);
                f.write_all(&data)?;
                f.sync_all()?;
            }
        }
        fs::fsync(&dir)?;
    }
    Ok(())
}

#[cfg(test)]
pub(super) fn prepare(
    store: &Store,
    root: &Path,
    id: &str,
    patch: Option<&str>,
) -> Result<(), Error> {
    prepare_inputs(store, root, id, patch, &[])
}

pub(super) fn prepare_inputs(
    store: &Store,
    root: &Path,
    id: &str,
    patch: Option<&str>,
    entries: &[Input],
) -> Result<(), Error> {
    key(id)?;
    // 目录 API 的写操作也持有 store 锁，直到输入已完整复制才释放它。
    store.read(|db| {
        if let Some(table) = db.get("executorAttempts") {
            let attempts = table
                .as_object()
                .ok_or_else(|| Error::Internal("尝试表无效".into()))?;
            if attempts.contains_key(id) {
                return Err(Error::Conflict("尝试已登记".into()));
            }
        }
        let source = patch.map(|p| patch_dir(store, db, p)).transpose()?;
        let root = root_dir(root, true).map_err(file_error)?;
        let name = std::ffi::CString::new(id).map_err(|_| Error::Invalid("尝试标识无效".into()))?;
        let clean = || discard(&root, &name, 0, &mut (ENTRY_LIMIT + 4));
        match clean() {
            Ok(()) => (),
            Err(e) if e.kind() == io::ErrorKind::NotFound => (),
            Err(e) => return Err(file_error(e)),
        }
        let attempt = mkdir(&root, id).map_err(file_error)?;
        let result = (|| -> io::Result<()> {
            let workspace = mkdir(&attempt, "workspace")?;
            let inputs = mkdir(&workspace, "inputs")?;
            mkdir(&workspace, "artifacts")?;
            if let Some(source) = source {
                Budget::default().copy_tree(&source, &inputs, "")?;
            }
            import(entries, &inputs)?;
            fs::fsync(&workspace)?;
            fs::fsync(&attempt)?;
            Ok(fs::fsync(&root)?)
        })();
        if result.is_err() {
            let _ = clean();
        }
        result.map_err(file_error)
    })
}

pub(super) fn publish(store: &Store, root: &Path, id: &str, status: &str) -> Result<Value, Error> {
    key(id)?;
    if !matches!(status, "succeeded" | "failed" | "cancelled") {
        return Err(Error::Invalid("未确认终态不能发布制品".into()));
    }
    let src = root_dir(root, false)
        .and_then(|root| subdir(&root, id))
        .and_then(private)
        .and_then(|dir| subdir(&dir, "workspace"))
        .and_then(private)
        .and_then(|dir| subdir(&dir, "artifacts"))
        .and_then(private)
        .map_err(file_error)?;
    // allocate 在 store 私有根中创建目录。先确认该根的祖先也没有被换成链接。
    host_dir(store.dir()).map_err(file_error)?;
    directories::allocate(
        store,
        directories::Rules::default(),
        |dst| {
            let dst_fd = host_dir(dst).map_err(file_error)?;
            Budget::default()
                .copy_tree(&src, &dst_fd, "")
                .map_err(file_error)?;
            fs::fsync(
                host_dir(dst.parent().expect("allocated directory parent")).map_err(file_error)?,
            )
            .map_err(|e| file_error(e.into()))
        },
        |db, dir| {
            directories::freeze(db, dir)?;
            let attempt = db["executorAttempts"]
                .get_mut(id)
                .ok_or_else(|| Error::NotFound("尝试不存在".into()))?;
            let result = attempt
                .get_mut("result")
                .filter(|r| r.is_object())
                .ok_or_else(|| Error::Internal("尝试结果无效".into()))?;
            if !result["artifactDirectoryId"].is_null() {
                return Err(Error::Conflict("制品已冻结".into()));
            }
            result["status"] = json!(status);
            result["artifactDirectoryId"] = json!(dir);
            Ok(result.clone())
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs as host,
        os::unix::{
            fs::{PermissionsExt, symlink},
            net::UnixListener,
        },
        path::PathBuf,
    };
    use uuid::Uuid;

    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            Self(std::env::temp_dir().join(Uuid::new_v4().to_string()))
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = host::remove_dir_all(&self.0);
        }
    }
    fn setup() -> (Temp, Store, PathBuf) {
        let temp = Temp::new();
        let store = Store::open(temp.0.join("work")).unwrap();
        let root = store.dir().join("executor");
        (temp, store, root)
    }
    fn register(store: &Store) {
        store
            .update(|db| {
                db["executorAttempts"]["a"] =
                    json!({"result":{"status":"running", "backendRunRef":"run:a"}});
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn snapshots_work_patch_and_publishes_only_frozen_artifacts() {
        let (_tmp, store, root) = setup();
        let directory = directories::allocate(
            &store,
            Default::default(),
            |dst| {
                host::create_dir(dst.join("nested")).unwrap();
                host::write(dst.join("nested/input"), [255, 0]).unwrap();
                Ok(())
            },
            |db, dir| {
                db["workPatches"]["patch"] = json!({"id":"patch","directoryId":dir});
                Ok(dir.to_owned())
            },
        )
        .unwrap();
        prepare(&store, &root, "a", Some("patch")).unwrap();
        register(&store);
        let workspace = root.join("a/workspace");
        for dir in [
            &root,
            &root.join("a"),
            &workspace,
            &workspace.join("inputs"),
            &workspace.join("artifacts"),
        ] {
            assert_eq!(
                host::metadata(dir).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        host::write(
            store
                .dir()
                .join("directories")
                .join(directory)
                .join("nested/input"),
            b"edited",
        )
        .unwrap();
        assert_eq!(
            host::read(workspace.join("inputs/nested/input")).unwrap(),
            [255, 0]
        );
        host::create_dir(workspace.join("artifacts/empty")).unwrap();
        let report = workspace.join("artifacts/report");
        host::write(&report, b"report").unwrap();
        let result = publish(&store, &root, "a", "succeeded").unwrap();
        let id = result["artifactDirectoryId"].as_str().unwrap();
        assert_eq!(
            result,
            json!({"status":"succeeded", "artifactDirectoryId":id, "backendRunRef":"run:a"})
        );
        store
            .read(|db| {
                assert_eq!(db["directories"][id]["state"], "frozen");
                assert_eq!(db["executorAttempts"]["a"]["result"], result);
                Ok(())
            })
            .unwrap();
        host::write(report, b"after freeze").unwrap();
        let frozen = store.dir().join("directories").join(id);
        assert!(frozen.join("empty").is_dir());
        assert_eq!(host::read(frozen.join("report")).unwrap(), b"report");
        assert_eq!(host::read_dir(frozen).unwrap().count(), 2);
    }

    #[test]
    fn restart_replaces_only_unregistered_workspace_without_following_links() {
        let (temp, store, root) = setup();
        let path = store.dir().to_owned();
        prepare(&store, &root, "a", None).unwrap();
        drop(store);
        let external = temp.0.join("outside");
        host::create_dir(&external).unwrap();
        host::write(external.join("keep"), b"keep").unwrap();
        let stale = root.join("a/workspace/artifacts/stale");
        symlink(&external, &stale).unwrap();
        let reopened = Store::open(path).unwrap();
        prepare(&reopened, &root, "a", None).unwrap();
        assert!(!stale.exists());
        assert_eq!(host::read(external.join("keep")).unwrap(), b"keep");
        register(&reopened);
        host::write(&stale, b"registered").unwrap();
        assert!(prepare(&reopened, &root, "a", None).is_err());
        assert_eq!(host::read(stale).unwrap(), b"registered");
    }

    #[test]
    fn rejects_ancestor_links_and_bad_ids() {
        let (temp, store, root) = setup();
        let alias = temp.0.join("alias");
        symlink(store.dir(), &alias).unwrap();
        assert!(prepare(&store, &alias.join("executor"), "a", None).is_err());
        assert!(!root.exists());
        assert!(prepare(&store, &root, "../escape", None).is_err());
        assert!(prepare(&store, &root, "a", Some("unknown")).is_err());
        prepare(&store, &root, "a", None).unwrap();
        register(&store);
        host::rename(root.join("a/workspace"), root.join("original")).unwrap();
        symlink(root.join("original"), root.join("a/workspace")).unwrap();
        assert!(publish(&store, &root, "a", "succeeded").is_err());
    }

    #[test]
    fn invalid_output_never_registers_success_or_partial_directory() {
        let (temp, store, root) = setup();
        prepare(&store, &root, "a", None).unwrap();
        register(&store);
        let output = root.join("a/workspace/artifacts");
        host::write(output.join("valid"), b"ok").unwrap();
        let bad = output.join("bad");
        let other = temp.0.join("other");
        host::write(&other, b"other").unwrap();
        let before = store.read(|db| Ok(db.clone())).unwrap();
        let rejected = || {
            assert!(publish(&store, &root, "a", "succeeded").is_err());
            assert_eq!(store.read(|db| Ok(db.clone())).unwrap(), before);
            assert_eq!(
                host::read_dir(store.dir().join("directories"))
                    .unwrap()
                    .count(),
                0
            );
        };
        symlink(&other, &bad).unwrap();
        rejected();
        host::remove_file(&bad).unwrap();
        host::hard_link(&other, &bad).unwrap();
        rejected();
        host::remove_file(&bad).unwrap();
        // Linux socket pathname limit is short; bind relative to the pinned directory.
        let parent = host_dir(&output).unwrap();
        let _listener =
            UnixListener::bind(format!("/proc/self/fd/{}/bad", parent.as_raw_fd())).unwrap();
        rejected();
        host::remove_file(&bad).unwrap();
        File::create(&bad)
            .unwrap()
            .set_len(directories::fs::FILE_LIMIT + 1)
            .unwrap();
        rejected();
        host::remove_file(&bad).unwrap();
        host::create_dir_all(output.join("d/".repeat(33))).unwrap();
        rejected();
    }

    #[test]
    fn remaining_entry_and_byte_budgets_apply_across_subtrees() {
        let (_tmp, store, _) = setup();
        let parent = host_dir(store.dir()).unwrap();
        let src = mkdir(&parent, "src").unwrap();
        let sub = mkdir(&src, "nested").unwrap();
        host::write(store.dir().join("src/nested/body"), [1, 2]).unwrap();
        drop(sub);
        for (name, mut budget) in [
            (
                "entries",
                Budget {
                    entries: ENTRY_LIMIT - 1,
                    bytes: 0,
                },
            ),
            (
                "bytes",
                Budget {
                    entries: 0,
                    bytes: TOTAL_LIMIT - 1,
                },
            ),
        ] {
            assert!(
                budget
                    .copy_tree(&src, &mkdir(&parent, name).unwrap(), "")
                    .is_err()
            );
            assert!(!store.dir().join(name).join("nested/body").exists());
        }
    }
}
