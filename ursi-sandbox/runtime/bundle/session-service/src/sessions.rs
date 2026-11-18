use crate::{
    Outbox, RpcError,
    config::{Config, MAX_SESSIONS, WorkingDirectory, write_private},
    pi::{PiProcess, SpawnSpec, Turn, acp_update},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::HashMap, os::fd::AsRawFd, path::PathBuf, sync::Arc};
use tokio::sync::{Mutex, Notify, watch};

pub struct Sessions {
    pub config: Config,
    items: Mutex<HashMap<String, Arc<Session>>>,
    stopping: std::sync::atomic::AtomicBool,
}
struct Session {
    id: String,
    cwd: PathBuf,
    directory: Option<WorkingDirectory>,
    inner: Mutex<Inner>,
    cancel: watch::Sender<bool>,
    finished: Notify,
    close_lock: Mutex<()>,
}
struct Inner {
    state: String,
    pid: Option<u32>,
    process: Option<PiProcess>,
    closing: bool,
    runtime: Option<PathBuf>,
    cleanup_failed: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    session_id: String,
    state: String,
    cwd: PathBuf,
    cleanup_failed: bool,
}

impl Sessions {
    pub fn load(config: Config) -> Result<Arc<Self>, &'static str> {
        let mut items = HashMap::new();
        for entry in std::fs::read_dir(&config.state_dir).map_err(|_| "state unavailable")? {
            let path = entry.map_err(|_| "state unavailable")?.path();
            if path.extension().is_none_or(|ext| ext != "json") {
                continue;
            }
            if items.len() >= 256 {
                return Err("too many saved sessions");
            }
            let mut record: Record =
                serde_json::from_slice(&std::fs::read(&path).map_err(|_| "state unavailable")?)
                    .map_err(|_| "invalid session state")?;
            if uuid::Uuid::parse_str(&record.session_id).is_err()
                || path.file_stem().and_then(|s| s.to_str()) != Some(&record.session_id)
            {
                return Err("invalid session identity");
            }
            if matches!(record.state.as_str(), "idle" | "running") {
                record.state = "interrupted".into();
                // 服务锁只能证明监督器已退出，崩溃恢复无法补造它的清理回执。
                record.cleanup_failed = true;
            }
            let (cancel, _) = watch::channel(false);
            let session = Arc::new(Session {
                id: record.session_id.clone(),
                cwd: record.cwd,
                directory: None,
                inner: Mutex::new(Inner {
                    state: record.state.clone(),
                    pid: None,
                    process: None,
                    closing: false,
                    runtime: None,
                    cleanup_failed: record.cleanup_failed,
                }),
                cancel,
                finished: Notify::new(),
                close_lock: Mutex::new(()),
            });
            persist(&config, &session, &record.state, record.cleanup_failed)
                .map_err(|_| "state recovery failed")?;
            items.insert(record.session_id, session);
        }
        Ok(Arc::new(Self {
            config,
            items: Mutex::new(items),
            stopping: std::sync::atomic::AtomicBool::new(false),
        }))
    }
    pub async fn new_session(&self, cwd: &str) -> Result<Value, RpcError> {
        if self.stopping.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(RpcError::business("service stopping"));
        }
        let directory = WorkingDirectory::open(&self.config, cwd).map_err(RpcError::params)?;
        let cwd = directory.path.clone();
        let mut items = self.items.lock().await;
        let mut live = 0;
        let mut terminal = None;
        for (id, session) in items.iter() {
            let inner = session.inner.lock().await;
            if matches!(inner.state.as_str(), "idle" | "running") {
                live += 1;
            } else {
                terminal = Some(id.clone());
            }
        }
        if live >= MAX_SESSIONS {
            return Err(RpcError::business("session limit reached"));
        }
        if items.len() >= 256 {
            let id = terminal.ok_or_else(|| RpcError::business("session history limit reached"))?;
            std::fs::remove_file(self.config.state_dir.join(format!("{id}.json")))
                .map_err(|_| RpcError::business("state write failed"))?;
            items.remove(&id);
        }
        let id = uuid::Uuid::new_v4().to_string();
        let (cancel, _) = watch::channel(false);
        let session = Arc::new(Session {
            id: id.clone(),
            cwd,
            directory: Some(directory),
            inner: Mutex::new(Inner {
                state: "idle".into(),
                pid: None,
                process: None,
                closing: false,
                runtime: None,
                cleanup_failed: false,
            }),
            cancel,
            finished: Notify::new(),
            close_lock: Mutex::new(()),
        });
        persist(&self.config, &session, "idle", false)?;
        items.insert(id.clone(), session);
        Ok(json!({"sessionId":id}))
    }
    async fn get(&self, id: &str) -> Result<Arc<Session>, RpcError> {
        self.items
            .lock()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| RpcError::business("unknown session"))
    }
    pub async fn status(&self, id: &str) -> Result<Value, RpcError> {
        let session = self.get(id).await?;
        let mut inner = session.inner.lock().await;
        refresh_idle(&self.config, &session, &mut inner).await?;
        Ok(json!({"sessionId":id,"state":inner.state,"pid":inner.pid}))
    }
    pub async fn cancel(&self, id: &str) -> Result<(), RpcError> {
        let session = self.get(id).await?;
        let inner = session.inner.lock().await;
        if inner.state == "running" {
            session.cancel.send_replace(true);
        }
        Ok(())
    }
    /// 在 WS 读循环内预留执行槽，然后启动任务，避免把并发请求排到前一个执行之后。
    pub async fn prompt(
        self: &Arc<Self>,
        id: &str,
        prompt: String,
        request_id: Value,
        output: Outbox,
    ) -> Result<(), RpcError> {
        let session = self.get(id).await?;
        let mut inner = session.inner.lock().await;
        refresh_idle(&self.config, &session, &mut inner).await?;
        if inner.state != "idle"
            || inner.closing
            || self.stopping.load(std::sync::atomic::Ordering::SeqCst)
        {
            return Err(RpcError::business("session is not idle"));
        }
        persist(&self.config, &session, "running", false)?;
        inner.state = "running".into();
        let process = inner.process.take();
        let manager = self.clone();
        drop(inner);
        tokio::spawn(async move {
            manager
                .execute(session, process, prompt, request_id, output)
                .await;
        });
        Ok(())
    }
    async fn execute(
        self: Arc<Self>,
        session: Arc<Session>,
        mut process: Option<PiProcess>,
        prompt: String,
        request_id: Value,
        output: Outbox,
    ) {
        let mut cancel = session.cancel.subscribe();
        let operation = async {
            // 包括复用已有 Pi 的每一轮，先校验创建时的路径和目录身份。
            let directory = session
                .directory
                .as_ref()
                .ok_or_else(|| RpcError::params("session cwd unavailable"))?;
            directory.validate(&self.config).map_err(RpcError::params)?;
            if process.is_none() {
                // 创建与启动都在任务内，但取消信号始终由独立 WS 读循环投递。
                let runtime = {
                    let mut inner = session.inner.lock().await;
                    let runtime = self
                        .config
                        .prepare_runtime(&session.id)
                        .map_err(RpcError::business)?;
                    inner.runtime = Some(runtime.clone());
                    runtime
                };
                let spec = SpawnSpec {
                    bin: self.config.pi_bin.clone(),
                    runtime_dir: runtime,
                    provider: self.config.provider.clone(),
                    model: self.config.model.clone(),
                };
                let exe = std::env::current_exe()
                    .map_err(|_| RpcError::business("supervisor unavailable"))?;
                let child = PiProcess::spawn(
                    spec,
                    &exe,
                    self.config.lock.as_raw_fd(),
                    &directory.directory,
                )
                .map_err(|_| RpcError::business("Pi startup failed"))?;
                let pid = child.pid();
                // spawn 后先登记清理句柄，再经过可取消的 await。
                process = Some(child);
                session.inner.lock().await.pid = pid;
                process
                    .as_mut()
                    .unwrap()
                    .configure()
                    .await
                    .map_err(|_| RpcError::business("Pi configuration failed"))?;
            }
            directory.validate(&self.config).map_err(RpcError::params)?;
            let process = process.as_mut().unwrap();
            let id = process
                .send("prompt", json!({"message":prompt}))
                .await
                .map_err(|_| RpcError::business("Pi prompt submission failed"))?;
            let mut turn = Turn::default();
            loop {
                let event = process
                    .next()
                    .await
                    .map_err(|_| RpcError::business("Pi stream failed"))?;
                if let Some(update) = acp_update(&event) {
                    output.send(json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":session.id,"update":update}}));
                }
                if turn
                    .observe(&event, &id)
                    .map_err(|_| RpcError::business("Pi model or protocol failed"))?
                {
                    return Ok::<_, RpcError>(());
                }
            }
        };
        let result = tokio::select! {
            biased;
            _ = async { if !*cancel.borrow_and_update() { let _ = cancel.changed().await; } } => Err(RpcError::cancelled()),
            result = tokio::time::timeout(self.config.deadline, operation) => result.unwrap_or_else(|_| Err(RpcError::business("task deadline exceeded"))),
        };
        // 临界区先确认取消/关闭，避免 settled 与取消同时到达时恢复 idle。
        let mut inner = session.inner.lock().await;
        let cancelled = *cancel.borrow() || result.as_ref().is_err_and(|e| e.code == -32800);
        let mut cleanup_failed = false;
        if cancelled || result.is_err() || inner.closing {
            drop(inner);
            if let Some(child) = process.as_mut() {
                cleanup_failed = child.stop(cancelled).await.is_err();
            }
            inner = session.inner.lock().await;
            inner.pid = process.as_ref().and_then(PiProcess::pid);
            if inner.pid.is_some() {
                inner.process = process.take();
            }
            inner.cleanup_failed = cleanup_failed;
            if let Some(runtime) = inner.runtime.take() {
                let _ = std::fs::remove_dir_all(runtime);
            }
            inner.state =
                if cleanup_failed || self.stopping.load(std::sync::atomic::Ordering::SeqCst) {
                    "interrupted"
                } else if inner.closing {
                    "closed"
                } else if cancelled {
                    "cancelled"
                } else {
                    "interrupted"
                }
                .into();
        } else {
            inner.process = process.take();
            inner.state = "idle".into();
        }
        let saved = persist(&self.config, &session, &inner.state, inner.cleanup_failed);
        let response = if self.stopping.load(std::sync::atomic::Ordering::SeqCst) {
            Err(RpcError::business("service interrupted"))
        } else if cleanup_failed {
            Err(RpcError::business("process cleanup failed"))
        } else if let Err(error) = saved {
            Err(error)
        } else if cancelled {
            Ok(json!({"stopReason":"cancelled"}))
        } else {
            result.map(|_| json!({"stopReason":"end_turn"}))
        };
        output.send(crate::response(request_id, response));
        drop(inner);
        session.finished.notify_waiters();
    }
    pub async fn close(&self, id: &str) -> Result<Value, RpcError> {
        let session = self.get(id).await?;
        let _close_guard = session.close_lock.lock().await;
        loop {
            let notified = session.finished.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let mut inner = session.inner.lock().await;
            inner.closing = true;
            if inner.state == "running" {
                session.cancel.send_replace(true);
                drop(inner);
                notified.await;
                continue;
            }
            if let Some(mut process) = inner.process.take() {
                // idle 进程回收期间也保持状态不可执行。
                drop(inner);
                let failed = process.stop(false).await.is_err();
                inner = session.inner.lock().await;
                inner.cleanup_failed = failed;
                inner.pid = process.pid();
                if inner.pid.is_some() {
                    inner.process = Some(process);
                }
            }
            inner.state = if inner.cleanup_failed
                || self.stopping.load(std::sync::atomic::Ordering::SeqCst)
            {
                "interrupted"
            } else {
                "closed"
            }
            .into();
            if let Some(runtime) = inner.runtime.take() {
                let _ = std::fs::remove_dir_all(runtime);
            }
            persist(&self.config, &session, &inner.state, inner.cleanup_failed)?;
            return if inner.cleanup_failed {
                Err(RpcError::business("process cleanup failed"))
            } else {
                Ok(json!({}))
            };
        }
    }
    pub async fn shutdown(&self) {
        self.stopping
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let mut ids = Vec::new();
        for (id, session) in self.items.lock().await.iter() {
            if matches!(
                session.inner.lock().await.state.as_str(),
                "idle" | "running"
            ) {
                ids.push(id.clone());
            }
        }
        for id in &ids {
            let _ = self.cancel(id).await;
        }
        for id in ids {
            let _ = self.close(&id).await;
        }
    }
}
async fn refresh_idle(
    config: &Config,
    session: &Session,
    inner: &mut Inner,
) -> Result<(), RpcError> {
    let exited = if inner.state == "idle" {
        match inner.process.as_mut() {
            Some(process) => process
                .exited()
                .map_err(|_| RpcError::business("process status unavailable"))?,
            None => false,
        }
    } else {
        false
    };
    if exited {
        let mut process = inner.process.take().unwrap();
        inner.cleanup_failed = process.stop(false).await.is_err();
        inner.pid = process.pid();
        if inner.pid.is_some() {
            inner.process = Some(process);
        }
        inner.state = "interrupted".into();
        if let Some(runtime) = inner.runtime.take() {
            let _ = std::fs::remove_dir_all(runtime);
        }
        persist(config, session, "interrupted", inner.cleanup_failed)?;
    }
    Ok(())
}
fn persist(
    config: &Config,
    session: &Session,
    state: &str,
    cleanup_failed: bool,
) -> Result<(), RpcError> {
    let record = Record {
        session_id: session.id.clone(),
        state: state.into(),
        cwd: session.cwd.clone(),
        cleanup_failed,
    };
    let target = config.state_dir.join(format!("{}.json", session.id));
    let temporary = config.state_dir.join(format!("{}.tmp", session.id));
    let data =
        serde_json::to_vec(&record).map_err(|_| RpcError::business("state encoding failed"))?;
    let _ = std::fs::remove_file(&temporary);
    write_private(&temporary, &data)
        .and_then(|_| std::fs::rename(temporary, target))
        .and_then(|_| std::fs::File::open(&config.state_dir)?.sync_all())
        .map_err(|_| RpcError::business("state write failed"))
}
