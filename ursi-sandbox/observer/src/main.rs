//! Optional Linux host observation service. Only a capture thread changes netns.
mod capture;
use anyhow::{Context, Result, ensure};
use axum::{
    Json, Router,
    body::Body,
    extract::{Path, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use capture::CaptureStatus;
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File},
    io,
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::fs::{FileTypeExt, MetadataExt, PermissionsExt},
    },
    path::{Path as FsPath, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio_util::io::ReaderStream;
use uuid::Uuid;

type Http<T> = std::result::Result<T, StatusCode>;
#[derive(Clone)]
struct App {
    root: Arc<PathBuf>,
    limit: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Target {
    generation: u64,
    container: String,
    pid: i32,
    started_at: String,
    docker_host: String,
}
#[derive(Serialize, Deserialize, Clone)]
struct Record {
    observation_id: String,
    sandbox_id: String,
    generation: u64,
    container: String,
    container_started_at: String,
    started_ms: u64,
    ended_ms: Option<u64>,
    reason: Option<String>,
    #[serde(flatten)]
    status: CaptureStatus,
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
}
fn directory(app: &App, id: &str, run: &str) -> Http<PathBuf> {
    if !valid_id(id) || Uuid::parse_str(run).is_err() || run.len() != 36 {
        return Err(StatusCode::BAD_REQUEST);
    }
    Ok(app.root.join(id).join(run))
}
fn lock(path: &FsPath) -> Http<File> {
    let f = File::options()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(io_error)?;
    f.try_lock_exclusive().map_err(|e| {
        if e.kind() == io::ErrorKind::WouldBlock {
            StatusCode::CONFLICT
        } else {
            io_error(e)
        }
    })?;
    Ok(f)
}
fn io_error(e: io::Error) -> StatusCode {
    if e.kind() == io::ErrorKind::NotFound {
        StatusCode::NOT_FOUND
    } else {
        eprintln!("observer I/O: {e}");
        StatusCode::SERVICE_UNAVAILABLE
    }
}
fn save(dir: &FsPath, rec: &Record) -> Result<()> {
    let tmp = dir.join("status.tmp");
    fs::write(&tmp, serde_json::to_vec(rec)?)?;
    fs::rename(tmp, dir.join("status.json"))?;
    Ok(())
}
// Pin both handles before asking the same local daemon to confirm the launch identity.
// pidfd readiness ends this capture even if the container ID is restarted unchanged.
async fn pin(t: &Target) -> Result<(OwnedFd, File)> {
    ensure!(
        t.pid > 0 && t.container.len() == 64 && t.container.bytes().all(|b| b.is_ascii_hexdigit()),
        "invalid target"
    );
    let path = t
        .docker_host
        .strip_prefix("unix://")
        .filter(|p| p.starts_with('/'))
        .context("local daemon required")?;
    let raw = unsafe { libc::syscall(libc::SYS_pidfd_open, t.pid, 0) } as i32;
    if raw < 0 {
        return Err(io::Error::last_os_error().into());
    }
    let pidfd = unsafe { OwnedFd::from_raw_fd(raw) };
    let ns = File::open(format!("/proc/{}/ns/net", t.pid))?;
    let identity = |m: fs::Metadata| (m.dev(), m.ino());
    ensure!(
        identity(ns.metadata()?) != identity(fs::metadata("/proc/self/ns/net")?),
        "refusing observer host network namespace"
    );
    let object: serde_json::Value = reqwest::Client::builder()
        .no_proxy()
        .unix_socket(PathBuf::from(path))
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(3))
        .build()?
        .get(format!("http://localhost/containers/{}/json", t.container))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    ensure!(
        object["Id"] == t.container
            && object["State"]["Running"] == true
            && object["State"]["Pid"] == t.pid
            && object["State"]["StartedAt"] == t.started_at
            && matches!(
                object["HostConfig"]["NetworkMode"].as_str(),
                Some("bridge" | "default")
            )
            && !exited(&pidfd, 0)?,
        "container instance changed"
    );
    Ok((pidfd, ns))
}
fn exited(fd: &OwnedFd, ms: i32) -> io::Result<bool> {
    let mut desc = libc::pollfd {
        fd: fd.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    loop {
        match unsafe { libc::poll(&mut desc, 1, ms) } {
            -1 if io::Error::last_os_error().kind() == io::ErrorKind::Interrupted => continue,
            -1 => return Err(io::Error::last_os_error()),
            n => return Ok(n != 0),
        }
    }
}
fn collect(dir: &FsPath, r: &mut Record, pid: OwnedFd, ns: File, limit: u64) -> Result<()> {
    let mut c = capture::start(ns, dir, limit)?;
    r.status = c.status();
    save(dir, r)?;
    let mut last = std::time::Instant::now();
    while !c.is_finished() {
        if dir.join("stop").try_exists()? {
            r.reason = Some("requested".into());
            break;
        }
        if exited(&pid, 200)? {
            r.reason = Some("container_exited".into());
            break;
        }
        if last.elapsed() >= Duration::from_secs(1) {
            r.status = c.status();
            save(dir, r)?;
            last = std::time::Instant::now();
        }
    }
    c.request_stop();
    while !c.is_finished() {
        std::thread::sleep(Duration::from_millis(25));
    }
    r.status = c.finish()?;
    Ok(())
}
async fn begin(
    State(app): State<App>,
    Path(id): Path<String>,
    Json(t): Json<Target>,
) -> Http<Response> {
    if !valid_id(&id) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let (pid, ns) = pin(&t).await.map_err(|e| {
        eprintln!("observer pin: {e:#}");
        StatusCode::CONFLICT
    })?;
    let parent = app.root.join(&id);
    fs::create_dir_all(&parent).map_err(io_error)?;
    let exclusive = lock(&parent.join("active.lock"))?;
    let run = Uuid::new_v4().to_string();
    let dir = parent.join(&run);
    fs::create_dir(&dir).map_err(io_error)?;
    let lease = lock(&dir.join("lease"))?;
    let mut rec = Record {
        observation_id: run,
        sandbox_id: id,
        generation: t.generation,
        container: t.container,
        container_started_at: t.started_at,
        started_ms: now(),
        ended_ms: None,
        reason: None,
        status: CaptureStatus {
            state: "starting".into(),
            error: None,
            packets: 0,
            bytes: 0,
            segments: 0,
            kernel_drops: 0,
            queue_drops: 0,
        },
    };
    save(&dir, &rec).map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    let initial = rec.clone();
    tokio::task::spawn_blocking(move || {
        let (_exclusive, _lease) = (exclusive, lease);
        if let Err(e) = collect(&dir, &mut rec, pid, ns, app.limit) {
            rec.status.state = "error".into();
            rec.status.error = Some(format!("{e:#}"));
        }
        rec.ended_ms = Some(now());
        if let Err(e) = save(&dir, &rec) {
            eprintln!("observer final status: {e:#}");
        }
    });
    Ok((StatusCode::ACCEPTED, Json(initial)).into_response())
}
async fn read_record(dir: &FsPath) -> Http<Record> {
    // Acquire/test lease before reading the atomic snapshot, avoiding a false crash on normal completion.
    let lease = File::open(dir.join("lease")).map_err(io_error)?;
    let finished = match FileExt::try_lock_shared(&lease) {
        Ok(()) => true,
        Err(e) if e.kind() == io::ErrorKind::WouldBlock => false,
        Err(e) => return Err(io_error(e)),
    };
    let bytes = tokio::fs::read(dir.join("status.json"))
        .await
        .map_err(io_error)?;
    let mut rec: Record =
        serde_json::from_slice(&bytes).map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    if finished && rec.ended_ms.is_none() {
        rec.status.state = "interrupted".into();
        rec.reason = Some("observer_interrupted".into());
        // Rotation may have created a segment after the last saved snapshot.
        let mut entries = tokio::fs::read_dir(dir).await.map_err(io_error)?;
        let mut segments = 0;
        while let Some(entry) = entries.next_entry().await.map_err(io_error)? {
            let name = entry.file_name();
            if let Some(n) = name.to_str().and_then(|s| {
                s.strip_prefix("capture-")?
                    .strip_suffix(".pcap")?
                    .parse::<u64>()
                    .ok()
            }) {
                segments = segments.max(n);
            }
        }
        rec.status.segments = segments;
    }
    Ok(rec)
}
async fn status(
    State(a): State<App>,
    Path((id, run)): Path<(String, String)>,
) -> Http<Json<Record>> {
    Ok(Json(read_record(&directory(&a, &id, &run)?).await?))
}
async fn stop(State(a): State<App>, Path((id, run)): Path<(String, String)>) -> Http<Response> {
    let dir = directory(&a, &id, &run)?;
    let r = read_record(&dir).await?;
    if r.ended_ms.is_some() || r.status.state == "interrupted" {
        return Ok(Json(r).into_response());
    }
    tokio::fs::write(dir.join("stop"), [])
        .await
        .map_err(io_error)?;
    Ok((StatusCode::ACCEPTED, Json(r)).into_response())
}
async fn segment(
    State(a): State<App>,
    Path((id, run, n)): Path<(String, String, u64)>,
) -> Http<Response> {
    let dir = directory(&a, &id, &run)?;
    let r = read_record(&dir).await?;
    if r.ended_ms.is_none() && r.status.state != "interrupted" {
        return Err(StatusCode::CONFLICT);
    }
    let f = tokio::fs::File::open(dir.join(format!("capture-{n:06}.pcap")))
        .await
        .map_err(io_error)?;
    let size = f.metadata().await.map_err(io_error)?.len();
    Ok((
        [
            (
                header::CONTENT_TYPE,
                "application/vnd.tcpdump.pcap".to_string(),
            ),
            (header::CONTENT_LENGTH, size.to_string()),
        ],
        Body::from_stream(ReaderStream::new(f)),
    )
        .into_response())
}
#[tokio::main]
async fn main() -> Result<()> {
    let root = PathBuf::from(
        std::env::var_os("URSI_OBSERVER_DIR")
            .context("set URSI_OBSERVER_DIR to a dedicated absolute directory")?,
    );
    ensure!(root.is_absolute(), "absolute directory required");
    let limit = std::env::var("URSI_OBSERVER_LIMIT_BYTES")
        .unwrap_or_else(|_| (1u64 << 30).to_string())
        .parse::<u64>()?;
    ensure!(limit >= 24, "limit must accommodate the PCAP header");
    unsafe { libc::umask(0o077) };
    fs::create_dir_all(&root)?;
    let _owner = lock(&root.join("owner.lock"))
        .map_err(|s| anyhow::anyhow!("cannot own observer directory: {s}"))?;
    let socket = root.join("observer.sock");
    if let Ok(m) = fs::symlink_metadata(&socket) {
        ensure!(m.file_type().is_socket(), "not a socket");
        fs::remove_file(&socket)?;
    }
    let listener = tokio::net::UnixListener::bind(&socket)?;
    fs::set_permissions(&socket, fs::Permissions::from_mode(0o660))?;
    let app = Router::new()
        .route("/{id}", post(begin))
        .route("/{id}/{run}", get(status))
        .route("/{id}/{run}/stop", post(stop))
        .route("/{id}/{run}/segments/{n}", get(segment))
        .with_state(App {
            root: Arc::new(root),
            limit,
        });
    axum::serve(listener, app).await?;
    Ok(())
}
