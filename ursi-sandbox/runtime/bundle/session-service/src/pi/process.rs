use super::Error;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs::File,
    io::Read,
    os::{
        fd::{AsRawFd, RawFd},
        unix::net::UnixStream,
    },
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::mpsc,
    task::JoinHandle,
};

pub const MAX_RECORD: usize = 1024 * 1024;

#[derive(Clone, Serialize, Deserialize)]
pub struct SpawnSpec {
    pub bin: PathBuf,
    pub runtime_dir: PathBuf,
    pub provider: String,
    pub model: String,
}

pub struct PiProcess {
    child: Child,
    input: ChildStdin,
    events: mpsc::Receiver<Result<Value, Error>>,
    reader: JoinHandle<()>,
    sequence: u64,
    cleanup: UnixStream,
    cleanup_confirmed: bool,
}
impl PiProcess {
    /// supervisor_exe 必须在 main 最前面处理 --ursi-pi-supervisor。
    pub fn spawn(
        spec: SpawnSpec,
        supervisor_exe: &Path,
        lock_fd: RawFd,
        cwd: &File,
    ) -> Result<Self, Error> {
        // 专用通道只交给 supervisor，Pi 无法伪造清理完成证据。
        let (cleanup, receipt) = UnixStream::pair()?;
        cleanup.set_nonblocking(true)?;
        let receipt_fd = receipt.as_raw_fd();
        let cwd_fd = cwd.as_raw_fd();
        let mut command = Command::new(supervisor_exe);
        command
            .arg("--ursi-pi-supervisor")
            .arg(serde_json::to_string(&spec).map_err(|_| Error::Protocol)?)
            .arg(std::process::id().to_string())
            .arg(lock_fd.to_string())
            .arg(receipt_fd.to_string())
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        unsafe {
            command.pre_exec(move || {
                // exec 与安装 handler 之间的取消也必须经过 supervisor 清理路径。
                let mut mask = std::mem::zeroed();
                libc::sigemptyset(&mut mask);
                libc::sigaddset(&mut mask, libc::SIGTERM);
                if libc::sigprocmask(libc::SIG_BLOCK, &mask, std::ptr::null_mut()) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::fchdir(cwd_fd) != 0 || libc::fcntl(receipt_fd, libc::F_SETFD, 0) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if lock_fd >= 0 && libc::fcntl(lock_fd, libc::F_SETFD, 0) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = command.spawn()?;
        let input = child.stdin.take().ok_or(Error::Protocol)?;
        let output = child.stdout.take().ok_or(Error::Protocol)?;
        let (tx, events) = mpsc::channel(32);
        let reader = tokio::spawn(async move {
            let mut reader = BufReader::new(output);
            let mut record = Vec::new();
            loop {
                let available = match reader.fill_buf().await {
                    Ok(b) => b,
                    Err(e) => {
                        let _ = tx.send(Err(Error::Io(e))).await;
                        break;
                    }
                };
                if available.is_empty() {
                    if !record.is_empty() {
                        let _ = tx.send(Err(Error::Protocol)).await;
                    }
                    break;
                }
                let newline = available.iter().position(|&b| b == b'\n');
                let n = newline.map(|i| i + 1).unwrap_or(available.len());
                if record.len() + n > MAX_RECORD {
                    let _ = tx.send(Err(Error::Protocol)).await;
                    break;
                }
                record.extend_from_slice(&available[..n]);
                reader.consume(n);
                if newline.is_some() {
                    let event =
                        serde_json::from_slice::<Value>(&record).map_err(|_| Error::Protocol);
                    let failed = event.is_err();
                    if tx.send(event).await.is_err() || failed {
                        break;
                    }
                    record.clear();
                }
            }
        });
        Ok(Self {
            child,
            input,
            events,
            reader,
            sequence: 0,
            cleanup,
            cleanup_confirmed: false,
        })
    }
    pub fn pid(&self) -> Option<u32> {
        self.child.id()
    }
    pub fn exited(&mut self) -> Result<bool, Error> {
        Ok(self.child.try_wait()?.is_some())
    }
    pub async fn send(&mut self, kind: &str, mut value: Value) -> Result<String, Error> {
        self.sequence += 1;
        let id = format!("pi-{}", self.sequence);
        value["id"] = json!(id);
        value["type"] = json!(kind);
        let mut data = serde_json::to_vec(&value).map_err(|_| Error::Protocol)?;
        data.push(b'\n');
        tokio::time::timeout(Duration::from_secs(2), self.input.write_all(&data))
            .await
            .map_err(|_| Error::Timeout)??;
        Ok(id)
    }
    pub async fn next(&mut self) -> Result<Value, Error> {
        tokio::select! {
            // 工具可能继承 stdout，即使 supervisor 死亡也不产生 EOF。
            status = self.child.wait() => {
                status?;
                Err(Error::SupervisorExited)
            }
            event = self.events.recv() => event.ok_or(Error::Protocol)?,
        }
    }
    pub async fn configure(&mut self) -> Result<(), Error> {
        for kind in ["set_auto_retry", "set_auto_compaction"] {
            let id = self.send(kind, json!({"enabled":false})).await?;
            tokio::time::timeout(Duration::from_secs(10), async {
                loop {
                    let event = self.next().await?;
                    if event["type"] == "response" && event["id"] == id {
                        return if event["command"] == kind && event["success"] == true {
                            Ok(())
                        } else {
                            Err(Error::Rejected)
                        };
                    }
                }
            })
            .await
            .map_err(|_| Error::Timeout)??;
        }
        Ok(())
    }
    /// 只有正常退出且收到 ECHILD 后的专用回执才确认清理完成。
    pub async fn stop(&mut self, cooperative: bool) -> Result<(), Error> {
        if cooperative {
            let _ = tokio::time::timeout(Duration::from_millis(250), async {
                let _ = self.send("clear_queue", json!({})).await;
                let _ = self.send("abort", json!({})).await;
                tokio::time::sleep(Duration::from_millis(100)).await;
            })
            .await;
        }
        if let Some(pid) = self.child.id() {
            unsafe {
                libc::kill(pid as i32, libc::SIGTERM);
            }
        }
        // 不主动 SIGKILL supervisor。外部 SIGKILL/OOM 不等于完成回收。
        let status = self.child.wait().await;
        self.reader.abort();
        let status = status?;
        if !self.cleanup_confirmed {
            let mut receipt = [0];
            self.cleanup_confirmed =
                self.cleanup.read(&mut receipt).ok() == Some(1) && receipt == [1];
        }
        if status.success() && self.cleanup_confirmed {
            Ok(())
        } else {
            Err(Error::CleanupUnconfirmed)
        }
    }
}
impl Drop for PiProcess {
    fn drop(&mut self) {
        if let Some(pid) = self.child.id() {
            unsafe {
                libc::kill(pid as i32, libc::SIGTERM);
            }
        }
        self.reader.abort();
    }
}
