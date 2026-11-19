//! One preprovisioned ACP endpoint dedicated to one work item. No Gateway or shell commands.
use super::{Error, Key, Outcome, Runtime, attempt_mut};
use axum::http::Uri;
use serde_json::Value;
use std::{
    ffi::CString,
    fs,
    os::unix::{ffi::OsStrExt, fs::MetadataExt},
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
    sync::watch,
    time::timeout,
};

#[derive(Clone)]
pub(super) struct Config {
    pub(super) bin: PathBuf,
    pub(super) url: String,
    pub(super) token_file: PathBuf,
    pub(super) cwd: String,
    pub(super) alias: String,
    pub(super) item: String,
}
fn unavailable() -> Error {
    Error::Unavailable("沙箱未获授权或配置不可用".into())
}

impl Config {
    pub(super) fn from_env() -> Option<Self> {
        if std::env::var_os("URSI_SESSION_TOKEN").is_some() {
            return None;
        }
        Some(Self {
            bin: std::env::var_os("URSI_SANDBOX_CLIENT_BIN")?.into(),
            url: std::env::var("URSI_ACP_URL").ok()?,
            token_file: std::env::var_os("URSI_SESSION_TOKEN_FILE")?.into(),
            cwd: std::env::var("URSI_SANDBOX_CWD").ok()?,
            alias: std::env::var("URSI_SANDBOX_ALIAS").ok()?,
            item: std::env::var("URSI_SANDBOX_ITEM_ID").ok()?,
        })
    }
    pub(super) fn authorize(&self, item: &str) -> Result<(), Error> {
        let uri: Uri = self.url.parse().map_err(|_| unavailable())?;
        if item != self.item
            || self.alias.is_empty()
            || self.alias.len() > 64
            || !self
                .alias
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            || !matches!(uri.scheme_str(), Some("ws" | "wss"))
            || uri.host().is_none()
            || self.url.contains(['@', '?', '#'])
            || uri.path() != "/acp"
            || !Path::new(&self.cwd).starts_with("/ursi/workspace")
            || Path::new(&self.cwd)
                .components()
                .any(|p| p == std::path::Component::ParentDir)
            || !trusted_file(&self.bin, false)
            || !trusted_file(&self.token_file, true)
        {
            return Err(unavailable());
        }
        Ok(())
    }
    pub(super) fn reserve(&self, _db: &Value, _item: &str) -> Result<(), Error> {
        Err(Error::Unavailable("沙箱执行器尚未迁移，当前不可用".into()))
    }
}

fn trusted_file(path: &Path, secret: bool) -> bool {
    if !path.is_absolute() || fs::canonicalize(path).ok().as_deref() != Some(path) {
        return false;
    }
    let ancestors: Vec<_> = path.ancestors().collect();
    for p in ancestors.into_iter().rev() {
        let Ok(m) = fs::symlink_metadata(p) else {
            return false;
        };
        if m.uid() != 0 && m.uid() != unsafe { libc::geteuid() } {
            return false;
        }
        if p == path {
            if !m.is_file() {
                return false;
            }
            if secret {
                return m.mode() & 0o477 == 0o400
                    && (1..=8192).contains(&m.len())
                    && fs::File::open(path).is_ok();
            }
            let Ok(name) = CString::new(path.as_os_str().as_bytes()) else {
                return false;
            };
            return m.mode() & 0o6022 == 0
                && unsafe { libc::access(name.as_ptr(), libc::X_OK) } == 0;
        } else if !m.is_dir()
            || (m.mode() & 0o022 != 0 && !(m.uid() == 0 && m.mode() & 0o1000 != 0))
        {
            return false;
        }
    }
    false
}

struct Reply {
    code: i32,
    result: Value,
    text: String,
}
const CONTROL: Duration = Duration::from_secs(15);
const TURN: Duration = Duration::from_secs(300);
impl Config {
    async fn call(&self, args: &[&str], prompt: Option<&str>) -> Option<Reply> {
        self.authorize(&self.item).ok()?;
        let deadline = if prompt.is_some() { TURN } else { CONTROL };
        let mut child = Command::new(&self.bin)
            .arg("acp")
            .args(args)
            .env_clear()
            .env("URSI_ACP_URL", &self.url)
            .env("URSI_SESSION_TOKEN_FILE", &self.token_file)
            .env("URSI_CLIENT_TIMEOUT_SECS", deadline.as_secs().to_string())
            .current_dir("/")
            .stdin(if prompt.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .ok()?;
        let mut out = child.stdout.take()?.take(512 * 1024 + 1);
        let mut input = child.stdin.take();
        let mut bytes = Vec::new();
        let (_, (), status) = timeout(deadline, async {
            tokio::try_join!(
                async {
                    let n = out.read_to_end(&mut bytes).await?;
                    if n > 512 * 1024 {
                        return Err(std::io::Error::other("ACP output limit"));
                    }
                    Ok(n)
                },
                async {
                    if let (Some(mut pipe), Some(text)) = (input.take(), prompt) {
                        pipe.write_all(text.as_bytes()).await?;
                        pipe.shutdown().await?;
                    }
                    Ok(())
                },
                child.wait()
            )
        })
        .await
        .ok()?
        .ok()?;
        let mut result = None;
        let mut text = String::new();
        for line in std::str::from_utf8(&bytes).ok()?.lines() {
            if result.is_some() {
                return None;
            }
            let v: Value = serde_json::from_str(line).ok()?;
            match v["type"].as_str()? {
                "result" if v["result"].is_object() => result = Some(v["result"].clone()),
                "update"
                    if prompt.is_some()
                        && v["params"]["sessionId"].as_str() == args.get(1).copied() =>
                {
                    let u = &v["params"]["update"];
                    if u["sessionUpdate"] == "agent_message_chunk" && u["content"]["type"] == "text"
                    {
                        text.push_str(u["content"]["text"].as_str()?);
                        if text.len() > 64 * 1024 {
                            return None;
                        }
                    }
                }
                _ => return None,
            }
        }
        for private in [
            &self.cwd,
            &self.url,
            self.bin.to_str()?,
            self.token_file.to_str()?,
        ] {
            text = text.replace(private, "[sandbox]");
        }
        Some(Reply {
            code: status.code()?,
            result: result?,
            text,
        })
    }
    async fn control(&self, op: &str, arg: &str) -> Option<Value> {
        let r = self.call(&[op, arg], None).await?;
        (r.code == 0).then_some(r.result)
    }
    pub(super) async fn closed(&self, id: &str) -> bool {
        self.control("status", id).await.is_some_and(|s| {
            s["sessionId"] == id && s["state"] == "closed" && s.get("pid") == Some(&Value::Null)
        })
    }
    async fn close(&self, id: &str) -> bool {
        self.control("close", id)
            .await
            .is_some_and(|r| r == serde_json::json!({}))
    }
}

fn unknown() -> Outcome {
    Outcome::new(
        "unverified",
        "未取得沙箱任务或清理证据；不会重发，请核实会话",
    )
}

pub(super) async fn run(
    rt: &Runtime,
    key: &Key,
    c: &Config,
    prompt: String,
    cancel: &mut watch::Receiver<bool>,
) -> Outcome {
    if *cancel.borrow() {
        return Outcome::new("cancelled", "未创建会话或发送任务");
    }
    let Some(new) = c.control("new", &c.cwd).await else {
        return Outcome::new("failed", "未取得新会话，未发送任务");
    };
    let Some(id) = new["sessionId"]
        .as_str()
        .filter(|id| uuid::Uuid::parse_str(id).is_ok())
    else {
        return Outcome::new("failed", "会话 ID 无效，未发送任务");
    };
    if rt
        .store
        .update(|db| {
            let a = attempt_mut(db, &key.0, &key.1)?;
            if a["status"] != "starting" || a["workspace"]["id"] != c.alias {
                return Err(Error::Conflict("尝试已变更".into()));
            }
            a["backendRunId"] = id.into();
            a["status"] = "running".into();
            Ok(())
        })
        .is_err()
    {
        let _ = c.close(id).await;
        return Outcome::new("failed", "无法持久化会话，未发送任务");
    }
    let outcome = if *cancel.borrow() {
        Outcome::new("cancelled", "未发送任务")
    } else {
        // The CLI opens its last positional argument as a text file. A pipe at /dev/stdin
        // avoids both a named prompt file surviving a crash and material in argv.
        let args = ["prompt", id, "/dev/stdin"];
        let turn = c.call(&args, Some(&prompt));
        tokio::pin!(turn);
        let reply = tokio::select! {
            biased;
            reply=&mut turn => reply,
            changed=cancel.changed() => {
                if changed.is_err() {return unknown();}
                let _=c.control("cancel",id).await;
                timeout(CONTROL,&mut turn).await.ok().flatten()
            }
        };
        match reply {
            Some(r) if r.code == 0 && r.result["stopReason"] == "end_turn" => {
                Outcome::new("succeeded", r.text)
            }
            Some(r) if r.code == 2 && r.result["stopReason"] == "cancelled" => {
                let Some(s) = c.control("status", id).await else {
                    return unknown();
                };
                if s["sessionId"] != id
                    || s["state"] != "cancelled"
                    || s.get("pid") != Some(&Value::Null)
                {
                    return unknown();
                }
                Outcome::new("cancelled", "原 prompt 返回 cancelled，会话已停止")
            }
            _ => return unknown(),
        }
    };
    if c.close(id).await {
        outcome
    } else {
        unknown()
    }
}
