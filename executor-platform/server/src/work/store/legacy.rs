//! One-way upgrade under work.lock, before the store is served. Keep the old
//! JSON as the retry record until all owned trees have been durably removed.
use crate::work::directories::fs::ROOT;
use rustix::{
    fd::AsFd,
    fs::{self, AtFlags, Dir, FileType, Mode, OFlags, ResolveFlags},
    io::Errno,
};
use serde_json::Value;
use std::{collections::BTreeSet, ffi::CStr, fs::File, io, path::Path};
use uuid::Uuid;

pub(super) fn present(db: &Value) -> bool {
    db.get("items").is_some()
        || db.get("configPackageSnapshots").is_some()
        || db["catalog"].get("packages").is_some()
}

pub(super) fn retire(store: &Path, db: &mut Value) -> io::Result<()> {
    let root = db.as_object_mut().expect("validated store root");
    let mut candidates = BTreeSet::new();
    if let Some(items) = root.remove("items") {
        for item in items.as_object().into_iter().flat_map(|m| m.values()) {
            for attempt in item["attempts"].as_array().into_iter().flatten() {
                if let Some(id) = attempt["artifactDirectory"]["id"].as_str() {
                    candidates.insert(id.to_owned());
                }
            }
        }
    }
    // This table was committed before the attempt itself, so it can contain
    // orphan snapshots. In contrast, snapshotRef.id can be a logical attempt ID.
    if let Some(snapshots) = root.remove("configPackageSnapshots") {
        for row in snapshots.as_object().into_iter().flat_map(|m| m.values()) {
            if let Some(id) = row["snapshotDirectoryId"].as_str() {
                candidates.insert(id.to_owned());
            }
        }
    }
    if let Some(catalog) = root.get_mut("catalog").and_then(Value::as_object_mut) {
        catalog.remove("packages");
    }
    // Any surviving owner (including unknown namespaces) wins. The directory
    // registry itself records existence, not ownership.
    for (table, value) in root.iter() {
        if table != "directories" {
            protect(value, &mut candidates);
        }
    }
    let Some(records) = root.get_mut("directories").and_then(Value::as_object_mut) else {
        return Ok(());
    };
    candidates.retain(|id| {
        Uuid::try_parse(id).is_ok_and(|u| u.to_string() == *id)
            && records.get(id).is_some_and(|r| r["id"] == id.as_str())
    });
    if candidates.is_empty() {
        return Ok(());
    }
    let store_fd = File::open(store)?;
    match open_dir(&store_fd, ROOT) {
        Ok(base) => {
            if fs::fstat(&base)?.st_mode & 0o077 != 0 {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "目录根不是私有目录",
                ));
            }
            for id in &candidates {
                match open_dir(&base, id.as_str()) {
                    Ok(dir) => {
                        empty_dir(&dir)?;
                        fs::unlinkat(&base, id.as_str(), AtFlags::REMOVEDIR)?;
                    }
                    Err(Errno::NOENT) => (), // Previous upgrade stopped before committing JSON.
                    Err(e) => return Err(e.into()),
                }
            }
            fs::fsync(&base)?;
        }
        Err(Errno::NOENT) => (),
        Err(e) => return Err(e.into()),
    }
    for id in candidates {
        records.remove(&id);
    }
    Ok(())
}

fn protect(value: &Value, candidates: &mut BTreeSet<String>) {
    match value {
        Value::Object(map) => {
            for (key, value) in map {
                candidates.remove(key);
                protect(value, candidates);
            }
        }
        Value::Array(values) => {
            for value in values {
                protect(value, candidates);
            }
        }
        Value::String(id) => {
            candidates.remove(id);
        }
        _ => (),
    }
}

// Pin every directory before inspecting or chmod'ing it. Never descend through
// a symlink or a mount (including a same-device bind mount) into another tree.
fn open_dir(
    parent: impl AsFd,
    name: impl rustix::path::Arg,
) -> rustix::io::Result<rustix::fd::OwnedFd> {
    fs::openat2(
        parent,
        name,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
        Mode::empty(),
        ResolveFlags::NO_SYMLINKS | ResolveFlags::NO_XDEV | ResolveFlags::BENEATH,
    )
}

fn empty_dir(dir: &impl AsFd) -> io::Result<()> {
    // Old config snapshots use 0500 even on nested directories. Do not chmod
    // regular files: they need only be unlinked and may have other hard links.
    fs::fchmod(dir, Mode::RWXU)?;
    for entry in Dir::read_from(dir)? {
        let entry = entry?;
        let name: &CStr = entry.file_name();
        if matches!(name.to_bytes(), b"." | b"..") {
            continue;
        }
        let stat = fs::statat(dir, name, AtFlags::SYMLINK_NOFOLLOW)?;
        let flags = if FileType::from_raw_mode(stat.st_mode) == FileType::Directory {
            empty_dir(&open_dir(dir, name)?)?;
            AtFlags::REMOVEDIR
        } else {
            AtFlags::empty()
        };
        fs::unlinkat(dir, name, flags)?;
    }
    Ok(())
}
