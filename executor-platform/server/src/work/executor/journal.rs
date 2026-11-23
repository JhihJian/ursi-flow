use super::binding::unavailable;
use crate::work::Error;
use serde_json::{Value, json};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::Path,
};
use uuid::Uuid;

const EVENTS: u64 = 512;
const FRAME: u64 = 16 * 1024;

fn private(file: &File) -> io::Result<()> {
    let m = file.metadata()?;
    if !m.is_file()
        || m.nlink() != 1
        || m.uid() != unsafe { libc::geteuid() }
        || m.mode() & 0o077 != 0
    {
        return Err(io::Error::other("invalid journal file"));
    }
    Ok(())
}

pub(super) fn lock(path: &Path, nonblock: bool) -> io::Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    private(&file)?;
    let flags = libc::LOCK_EX | if nonblock { libc::LOCK_NB } else { 0 };
    if unsafe { libc::flock(std::os::fd::AsRawFd::as_raw_fd(&file), flags) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(file)
}

pub(super) fn write(path: &Path, value: &Value) -> io::Result<()> {
    write_record(path, value, false)
}

fn write_record(path: &Path, value: &Value, immutable: bool) -> io::Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| io::Error::other("missing journal directory"))?;
    let tmp = dir.join(format!(".acp-{}", Uuid::new_v4()));
    let result = (|| {
        let mut f = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o400)
            .open(&tmp)?;
        serde_json::to_writer(&mut f, value)?;
        f.flush()?;
        f.sync_all()?;
        if immutable {
            rustix::fs::renameat_with(
                rustix::fs::CWD,
                &tmp,
                rustix::fs::CWD,
                path,
                rustix::fs::RenameFlags::NOREPLACE,
            )?;
        } else {
            fs::rename(&tmp, path)?;
        }
        File::open(dir)?.sync_all()
    })();
    if result.is_err() {
        let _ = fs::remove_file(tmp);
    }
    result
}

pub(super) fn read(path: &Path, max: u64) -> io::Result<Option<Value>> {
    let f = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
    {
        Ok(f) => f,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    private(&f)?;
    let mut bytes = Vec::new();
    f.take(max + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > max {
        return Err(io::Error::other("journal limit"));
    }
    Ok(Some(serde_json::from_slice(&bytes)?))
}

pub(super) fn running(dir: &Path) -> Result<bool, Error> {
    match lock(&dir.join("acp-worker.lock"), true) {
        Ok(_) => Ok(false),
        Err(e) if e.kind() == io::ErrorKind::WouldBlock => Ok(true),
        Err(_) => Err(unavailable()),
    }
}

pub(super) struct Trace {
    seq: u64,
    gaps: std::collections::HashSet<&'static str>,
}

impl Trace {
    pub(super) fn new() -> Self {
        Self {
            seq: 0,
            gaps: Default::default(),
        }
    }

    pub(super) fn gap(&mut self, dir: &Path, reason: &'static str) {
        if !self.gaps.contains(reason)
            && self
                .append(dir, json!({"kind":"gap","reason":reason}))
                .is_ok()
        {
            self.gaps.insert(reason);
        }
    }

    pub(super) fn append(&mut self, dir: &Path, event: Value) -> io::Result<()> {
        let _guard = lock(&dir.join("acp-events.lock"), false)?;
        // A directory fsync error after rename must never let a later write
        // replace a frame a reader may have already synced and published.
        while self.seq <= EVENTS && event_path(dir, self.seq + 1).try_exists()? {
            File::open(dir)?.sync_all()?;
            self.seq += 1;
        }
        self.append_locked(dir, event)
    }

    fn append_locked(&mut self, dir: &Path, mut event: Value) -> io::Result<()> {
        if self.seq > EVENTS {
            return Ok(());
        }
        if self.seq == EVENTS {
            event = json!({"kind":"gap","reason":"retention_limit"});
        }
        let next = self.seq + 1;
        event["seq"] = json!(next);
        if serde_json::to_vec(&event)?.len() as u64 > FRAME {
            return Err(io::Error::other("event size"));
        }
        write_record(&event_path(dir, next), &event, true)?;
        self.seq = next;
        Ok(())
    }
}

fn event_path(dir: &Path, seq: u64) -> std::path::PathBuf {
    dir.join(format!("acp-event-{seq}"))
}

fn mark_worker_loss(dir: &Path) -> io::Result<()> {
    let mut trace = Trace::new();
    let mut last = None;
    // Find the first empty slot in the contiguous, bounded journal.
    let (mut lo, mut hi) = (0, EVENTS + 2);
    while hi - lo > 1 {
        let mid = lo + (hi - lo) / 2;
        if event_path(dir, mid).try_exists()? {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    trace.seq = lo;
    if lo != 0 {
        last = read(&event_path(dir, lo), FRAME)?;
    }
    if last.is_some_and(|v| v["reason"] == "worker_lost") {
        return Ok(());
    }
    trace.append_locked(dir, json!({"kind":"gap","reason":"worker_lost"}))
}

// A rename can become visible before its directory sync. This is only a wake-up
// hint; page still takes the journal lock and commits records before returning them.
pub(super) fn next_frame_exists(dir: &Path, after: u64) -> Result<bool, Error> {
    if after > EVENTS {
        return Ok(false);
    }
    event_path(dir, after + 1)
        .try_exists()
        .map_err(|_| unavailable())
}

pub(super) fn page(dir: &Path, after: u64) -> Result<(Value, bool), Error> {
    let _guard = lock(&dir.join("acp-events.lock"), false).map_err(|_| unavailable())?;
    let running = running(dir)?;
    if !running
        && read(&dir.join("acp-result.json"), 1024)
            .map_err(|_| unavailable())?
            .is_none()
    {
        mark_worker_loss(dir).map_err(|_| unavailable())?;
    }
    // Commits a complete record left by a worker that died after rename.
    File::open(dir)
        .and_then(|f| f.sync_all())
        .map_err(|_| unavailable())?;
    let mut events = Vec::new();
    let mut cursor = after;
    while cursor <= EVENTS && events.len() < 64 {
        let seq = cursor + 1;
        let Some(event) = read(&event_path(dir, seq), FRAME).map_err(|_| unavailable())? else {
            break;
        };
        if event["seq"] != seq {
            return Err(unavailable());
        }
        events.push(event);
        cursor = seq;
    }
    Ok((json!({"events":events,"nextCursor":cursor}), running))
}
