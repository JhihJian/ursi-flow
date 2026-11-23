//! ACP v2 JSONL transport and managed agent preflight.
use crate::work::Error;
use serde_json::{Value, json};
use std::{
    fs::{self, DirBuilder, OpenOptions},
    io,
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    process::{ExitStatus, Stdio},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    time::{Instant, sleep, sleep_until, timeout, timeout_at},
};

const TRUSTED_PATH: &str = "/usr/local/bin:/usr/bin:/bin";
const FRAME_LIMIT: usize = 4 * 1024 * 1024;
const WRITE_TIMEOUT: Duration = Duration::from_secs(2);
const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(5);
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
const EXIT_GRACE: Duration = Duration::from_millis(250);
const REAP_TIMEOUT: Duration = Duration::from_secs(1);
const PROBE_MESSAGES: usize = 64;

fn unavailable() -> Error {
    Error::Unavailable("执行器不可用或协议响应无效".into())
}

pub(super) struct Connection {
    child: Child,
    group: libc::pid_t,
    input: Option<ChildStdin>,
    output: Option<BufReader<ChildStdout>>,
    frame: Vec<u8>,
    exit: Option<ExitStatus>,
    stopped: bool,
}

impl Connection {
    pub(super) fn spawn(
        bin: &Path,
        policy: &Path,
        root: &Path,
        job: Option<&Path>,
    ) -> Result<Self, Error> {
        Self::spawn_in(bin, policy, root, job, root)
    }

    fn spawn_in(
        bin: &Path,
        policy: &Path,
        root: &Path,
        job: Option<&Path>,
        cwd: &Path,
    ) -> Result<Self, Error> {
        if !bin.is_absolute()
            || !root.is_absolute()
            || !policy.is_absolute()
            || job.is_some_and(|path| !path.is_absolute())
        {
            return Err(unavailable());
        }
        let metadata = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
            .open(policy)
            .and_then(|f| f.metadata())
            .map_err(|_| unavailable())?;
        if !metadata.is_file()
            || metadata.mode() & 0o7777 != 0o600
            || (metadata.uid() != 0 && metadata.uid() != unsafe { libc::geteuid() })
        {
            return Err(unavailable());
        }

        let mut cmd = Command::new(bin);
        cmd.env_clear()
            .env("PATH", TRUSTED_PATH)
            .env("URSI_EXECUTOR_ROOT", root)
            .env("URSI_PI_POLICY", policy)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .process_group(0)
            .kill_on_drop(true);
        if let Some(job) = job {
            cmd.env("URSI_ACP_JOB", job);
            let parent = std::process::id() as libc::pid_t;
            // A crashed worker must not leave managed Pi running. Recheck the
            // parent to cover a crash between fork and installing the signal.
            unsafe {
                cmd.pre_exec(move || {
                    if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
                        return Err(io::Error::last_os_error());
                    }
                    if libc::getppid() != parent {
                        return Err(io::Error::from_raw_os_error(libc::ESRCH));
                    }
                    Ok(())
                });
            }
        }
        let mut child = cmd.spawn().map_err(|_| unavailable())?;
        // A freshly spawned, not-yet-waited child has a positive Linux pid_t.
        let group = child.id().ok_or_else(unavailable)? as libc::pid_t;
        Ok(Self {
            group,
            input: child.stdin.take(),
            output: child.stdout.take().map(BufReader::new),
            child,
            frame: Vec::new(),
            exit: None,
            stopped: false,
        })
    }

    pub(super) async fn send(&mut self, value: Value) -> Result<(), Error> {
        let mut frame = Frame(Vec::new());
        serde_json::to_writer(&mut frame, &value).map_err(|_| unavailable())?;
        frame.0.push(b'\n');
        // After a partial write, the pipe cannot be reused. Owning it here also
        // closes it if the caller cancels the send future.
        let mut input = self.input.take().ok_or_else(unavailable)?;
        timeout(WRITE_TIMEOUT, input.write_all(&frame.0))
            .await
            .map_err(|_| unavailable())?
            .map_err(|_| unavailable())?;
        self.input = Some(input);
        Ok(())
    }

    pub(super) async fn recv(&mut self) -> Result<Value, Error> {
        self.recv_next().await?.ok_or_else(unavailable)
    }

    pub(super) async fn recv_next(&mut self) -> Result<Option<Value>, Error> {
        let output = self.output.as_mut().ok_or_else(unavailable)?;
        let result = read_frame(output, &mut self.frame).await;
        self.frame.clear();
        if !matches!(result, Ok(Some(_))) {
            self.output.take();
        }
        result
    }

    pub(super) async fn initialize(&mut self, on_sent: impl FnOnce()) -> Result<(), Error> {
        timeout(INITIALIZE_TIMEOUT, async {
            self.send(json!({
                "jsonrpc": "2.0", "id": "initialize", "method": "initialize",
                "params": {
                    "protocolVersion": 2,
                    "info": {"name": "ursi-executor-platform", "version": env!("CARGO_PKG_VERSION")},
                    "capabilities": {}
                }
            }))
            .await?;
            on_sent();
            let response = self.recv().await?;
            let result = response_result(&response, "initialize")?;
            if result["protocolVersion"].as_u64() != Some(2)
                || nonempty(&result["info"]["name"]).is_none()
                || nonempty(&result["info"]["version"]).is_none()
                || !result["capabilities"]["session"]["systemPrompt"]["mode"]["override"].is_object()
            {
                return Err(unavailable());
            }
            Ok(())
        })
        .await
        .map_err(|_| unavailable())?
    }

    /// Close stdio and verify the managed group is gone. ACP session close is the caller's job.
    pub(super) async fn stop(&mut self) -> bool {
        self.input.take();
        if self.stopped {
            return true;
        }
        if self.exit.is_none() {
            let grace = Instant::now() + EXIT_GRACE;
            if let Some(mut output) = self.output.take() {
                let _ =
                    timeout_at(grace, tokio::io::copy(&mut output, &mut tokio::io::sink())).await;
            }
            sleep_until(grace).await;
            // Keep the leader unreaped until after signaling the group, so the
            // PGID cannot have been recycled when we send the signal.
            self.kill_group();
        }
        let deadline = Instant::now() + REAP_TIMEOUT;
        if self.exit.is_none() {
            self.exit = match timeout_at(deadline, self.child.wait()).await {
                Ok(Ok(status)) => Some(status),
                _ => return false,
            };
        }
        // The leader's exit does not prove its descendants are gone. After
        // reaping it, only probe the group: never send it a destructive signal.
        self.stopped = timeout_at(deadline, async {
            while !group_absent(self.group) {
                sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .is_ok();
        self.stopped
    }

    fn kill_group(&mut self) {
        unsafe { libc::kill(-self.group, libc::SIGKILL) };
        // Also target the direct child if it changed groups.
        let _ = self.child.start_kill();
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        if self.exit.is_none() {
            self.kill_group();
        }
    }
}

fn group_absent(group: libc::pid_t) -> bool {
    let rc = unsafe { libc::kill(-group, 0) };
    rc == -1 && io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
}

async fn read_frame(
    output: &mut BufReader<ChildStdout>,
    frame: &mut Vec<u8>,
) -> Result<Option<Value>, Error> {
    loop {
        let bytes = output.fill_buf().await.map_err(|_| unavailable())?;
        if bytes.is_empty() {
            return if frame.is_empty() {
                Ok(None)
            } else {
                Err(unavailable())
            };
        }
        let newline = bytes.iter().position(|&b| b == b'\n');
        let len = newline.map_or(bytes.len(), |pos| pos + 1);
        if len > FRAME_LIMIT - frame.len()
            || (newline.is_none() && len == FRAME_LIMIT - frame.len())
        {
            return Err(unavailable());
        }
        // Store bytes before consuming them, with no await between the two.
        // A cancelled recv can resume from this exact byte position.
        frame.extend_from_slice(&bytes[..len]);
        output.consume(len);
        if newline.is_some() {
            return serde_json::from_slice(frame)
                .map(Some)
                .map_err(|_| unavailable());
        }
    }
}

struct Frame(Vec<u8>);

impl io::Write for Frame {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() >= FRAME_LIMIT - self.0.len() {
            return Err(io::Error::other("frame too large"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn nonempty(value: &Value) -> Option<&str> {
    value.as_str().filter(|text| !text.is_empty())
}

fn rpc_id(value: &Value) -> bool {
    value.is_i64() || value.is_string()
}

fn response_result<'a>(message: &'a Value, id: &str) -> Result<&'a Value, Error> {
    if message["jsonrpc"] == "2.0"
        && message["id"] == id
        && message.get("method").is_none()
        && message.get("error").is_none()
        && message["result"].is_object()
    {
        Ok(&message["result"])
    } else {
        Err(unavailable())
    }
}

async fn probe_request(conn: &mut Connection, method: &str, params: Value) -> Result<Value, Error> {
    conn.send(json!({"jsonrpc": "2.0", "id": method, "method": method, "params": params}))
        .await?;
    for _ in 0..PROBE_MESSAGES {
        let mut message = conn.recv().await?;
        if message["jsonrpc"] != "2.0" {
            return Err(unavailable());
        }
        if message.get("method").is_none() {
            response_result(&message, method)?;
            return Ok(message["result"].take());
        }
        if message.get("result").is_some() || message.get("error").is_some() {
            return Err(unavailable());
        }
        let params = &message["params"];
        match message["method"].as_str() {
            Some("session/update")
                if message.get("id").is_none()
                    && nonempty(&params["sessionId"]).is_some()
                    && nonempty(&params["update"]["sessionUpdate"]).is_some() => {}
            Some("$/cancel_request")
                if message.get("id").is_none() && rpc_id(&params["requestId"]) => {}
            Some("session/request_permission") if rpc_id(&message["id"]) => {
                conn.send(json!({
                    "jsonrpc": "2.0", "id": &message["id"],
                    "result": {"outcome": {"outcome": "cancelled"}}
                }))
                .await?;
            }
            _ => return Err(unavailable()),
        }
    }
    Err(unavailable())
}

struct ProbeWorkspace(PathBuf);

impl ProbeWorkspace {
    fn new(root: &Path) -> Result<Self, Error> {
        if !root.is_absolute() {
            return Err(unavailable());
        }
        let cwd = root.join(format!(".probe-{}", uuid::Uuid::new_v4()));
        let mut builder = DirBuilder::new();
        builder
            .mode(0o700)
            .create(&cwd)
            .map_err(|_| unavailable())?;
        let workspace = Self(cwd);
        for name in ["inputs", "artifacts"] {
            builder
                .create(workspace.0.join(name))
                .map_err(|_| unavailable())?;
        }
        Ok(workspace)
    }
}

impl Drop for ProbeWorkspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub(in crate::work) async fn probe_agent(
    bin: &Path,
    policy: &Path,
    root: &Path,
) -> Result<(), Error> {
    let workspace = ProbeWorkspace::new(root)?;
    let cwd = workspace.0.to_str().ok_or_else(unavailable)?;
    let mut conn = Connection::spawn_in(bin, policy, root, None, &workspace.0)?;
    let result = timeout(PROBE_TIMEOUT, async {
        conn.initialize(|| {}).await?;
        let session = probe_request(
            &mut conn,
            "session/new",
            json!({
                "cwd": cwd, "mcpServers": [],
                "systemPrompt": {"mode": "override", "content": [
                    {"type": "text", "text": "This is a readiness probe. Do not perform any work."}
                ]}
            }),
        )
        .await?;
        let session_id = nonempty(&session["sessionId"]).ok_or_else(unavailable)?;
        probe_request(&mut conn, "session/close", json!({"sessionId": session_id})).await?;
        Ok(())
    })
    .await;
    if !conn.stop().await || !conn.exit.is_some_and(|status| status.success()) {
        return Err(unavailable());
    }
    result.map_err(|_| unavailable())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};

    fn fixture(script: &str) -> (ProbeWorkspace, PathBuf, PathBuf) {
        let root = ProbeWorkspace::new(&std::env::temp_dir()).unwrap();
        let bin = root.0.join("agent fixture");
        let policy = root.0.join("policy");
        fs::write(&policy, "{}").unwrap();
        fs::set_permissions(&policy, fs::Permissions::from_mode(0o600)).unwrap();
        fs::write(&bin, script).unwrap();
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o700)).unwrap();
        (root, bin, policy)
    }

    #[tokio::test]
    async fn probe_negotiates_opens_and_closes_without_prompting() {
        let (root, bin, policy) = fixture(
            r#"#!/usr/bin/python3
import json, os, stat, sys
root = os.environ['URSI_EXECUTOR_ROOT']
assert os.environ['URSI_PI_POLICY'] == root + '/policy'
assert os.environ['PATH'] == '/usr/local/bin:/usr/bin:/bin'
assert not set(os.environ) - {'LC_CTYPE', 'PATH', 'URSI_EXECUTOR_ROOT', 'URSI_PI_POLICY'}
mode = open(root + '/mode').read()
def read(method):
    r = json.loads(input())
    assert r['jsonrpc'] == '2.0' and r['method'] == method
    return r
def send(m): print(json.dumps(dict(jsonrpc='2.0', **m)), flush=True)
def reply(r, result): send(dict(id=r['id'], result=result))
def update(): send(dict(method='session/update', params=dict(sessionId='probe',
    update=dict(sessionUpdate='state_update', state='idle'))))
a = read('initialize')
assert a['params']['protocolVersion'] == 2 and a['params']['capabilities'] == {}
caps = {'session': {'systemPrompt': {'mode': {'override': {}}}}}
if mode == 'no-override': caps['session']['systemPrompt']['mode'] = {}
reply(a, dict(protocolVersion=1 if mode == 'old' else 2,
    info=dict(name='fixture', version='1'), capabilities=caps))
if mode in ('no-override', 'old'):
    assert sys.stdin.read() == ''
    sys.exit(0)
b = read('session/new')
cwd = b['params']['cwd']
assert os.path.dirname(cwd) == root and cwd == os.getcwd()
assert stat.S_IMODE(os.stat(cwd).st_mode) == 0o700
assert set(os.listdir(cwd)) == {'inputs', 'artifacts'}
prompt = b['params']['systemPrompt']
assert prompt['mode'] == 'override' and prompt['content'][0]['type'] == 'text'
assert prompt['content'][0]['text']
update()
send(dict(id=7, method='session/request_permission', params=dict(sessionId='probe',
    title='private', options=[dict(optionId='allow', name='Allow', kind='allow_once')])))
assert json.loads(input()) == {'jsonrpc':'2.0','id':7,'result':{'outcome':{'outcome':'cancelled'}}}
reply(b, {'sessionId':'probe'})
c = read('session/close')
assert c['params']['sessionId'] == 'probe'
update()
reply(c, {})
assert sys.stdin.read() == ''
print('private fixture detail', file=sys.stderr)
sys.exit(1 if mode == 'exit-error' else 0)
"#,
        );
        for mode in ["ok", "old", "no-override", "exit-error"] {
            fs::write(root.0.join("mode"), mode).unwrap();
            let result = probe_agent(&bin, &policy, &root.0).await;
            if mode == "ok" {
                result.unwrap();
            } else {
                let error = result.unwrap_err();
                assert!(matches!(error, Error::Unavailable(_)));
                assert!(!format!("{error:?}").contains("private fixture detail"));
            }
            assert!(!fs::read_dir(&root.0).unwrap().any(|entry| {
                entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".probe-")
            }));
        }
    }

    #[tokio::test]
    async fn spawn_requires_private_policy_and_absolute_job() {
        let (root, bin, policy) = fixture("#!/bin/sh\nprintf '\"%s\"\\n' \"$URSI_ACP_JOB\"\n");
        let link = root.0.join("linked-policy");
        symlink(&policy, &link).unwrap();
        assert!(Connection::spawn(&bin, &link, &root.0, None).is_err());
        assert!(Connection::spawn(&bin, &policy, &root.0, Some(Path::new("job"))).is_err());
        fs::set_permissions(&policy, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(Connection::spawn(&bin, &policy, &root.0, None).is_err());
        fs::set_permissions(&policy, fs::Permissions::from_mode(0o600)).unwrap();
        let job = root.0.join("job");
        let mut conn = Connection::spawn(&bin, &policy, &root.0, Some(&job)).unwrap();
        assert_eq!(conn.recv().await.unwrap(), job.to_str().unwrap());
        assert!(conn.stop().await);
    }

    #[tokio::test]
    async fn recv_resumes_partial_frame_and_rejects_truncated_eof() {
        let (root, bin, policy) =
            fixture("#!/bin/sh\nprintf 'null\\n{\"half\":'\nread unblock\nprintf 'true}\\n{}'\n");
        let mut conn = Connection::spawn(&bin, &policy, &root.0, None).unwrap();
        assert_eq!(conn.recv().await.unwrap(), Value::Null);
        assert!(
            timeout(Duration::from_millis(30), conn.recv())
                .await
                .is_err()
        );
        assert_eq!(conn.frame, b"{\"half\":");
        conn.send(json!("continue")).await.unwrap();
        assert_eq!(conn.recv().await.unwrap(), json!({"half": true}));
        assert!(conn.recv().await.is_err());
        assert!(conn.stop().await);
    }

    #[tokio::test]
    async fn rejects_oversized_frames_and_bounds_blocked_write() {
        let (root, bin, policy) = fixture(
            r#"#!/usr/bin/python3
import sys, time
sys.stdout.write(' ' * (4 * 1024 * 1024))
sys.stdout.flush()
time.sleep(30)
"#,
        );
        let mut conn = Connection::spawn(&bin, &policy, &root.0, None).unwrap();
        assert!(conn.send(json!("x".repeat(FRAME_LIMIT))).await.is_err());
        assert!(conn.input.is_some());
        assert!(
            timeout(Duration::from_secs(3), conn.recv())
                .await
                .unwrap()
                .is_err()
        );
        assert!(
            timeout(
                Duration::from_secs(3),
                conn.send(json!("x".repeat(1024 * 1024)))
            )
            .await
            .unwrap()
            .is_err()
        );
        assert!(conn.input.is_none());
        assert!(conn.stop().await);
    }

    #[tokio::test]
    async fn stop_kills_other_group_members_after_leader_exits() {
        let (root, _, policy) = fixture("");
        let mut conn = Connection::spawn(Path::new("/bin/true"), &policy, &root.0, None).unwrap();
        assert!(conn.recv().await.is_err());
        // Parent the peer here so it can be reaped even if PID 1 does not reap.
        let mut peer = Command::new("/bin/sleep")
            .arg("30")
            .process_group(conn.group)
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let (stopped, peer_exit) = timeout(Duration::from_secs(3), async {
            tokio::join!(conn.stop(), peer.wait())
        })
        .await
        .unwrap();
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(peer_exit.unwrap().signal(), Some(libc::SIGKILL));
        assert!(conn.exit.unwrap().success());
        assert!(stopped && group_absent(conn.group));
        assert!(conn.stop().await);
    }
}
