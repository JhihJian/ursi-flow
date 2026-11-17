//! 独立 Gateway / ACP 调用方。只依赖公开传输契约。
use std::{path::Path, time::Duration};

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::{
    net::TcpStream,
    time::{Instant, timeout_at},
};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream,
    tungstenite::{Message, client::IntoClientRequest},
};

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Invalid(String),
    #[error("传输失败")]
    Transport,
    #[error("操作超时，远端任务可能仍运行，请查询状态或显式取消")]
    Timeout,
    #[error("Gateway HTTP {status}: {code}")]
    Gateway { status: u16, code: String },
    #[error("ACP 错误 {code}: {message}")]
    Rpc { code: i64, message: String },
    #[error("ACP 连接关闭，远端任务可能仍运行")]
    Closed,
    #[error("协议错误: {0}")]
    Protocol(String),
    #[error("本地文件或进程操作失败: {0}")]
    Io(#[from] std::io::Error),
}

/// 凭据只能从环境或文件读取。不给 Debug 实现，避免意外输出。
pub struct Secret(String);
impl Secret {
    pub fn new(value: String) -> Result<Self> {
        let value = value.trim_end_matches(['\r', '\n']).to_owned();
        if value.is_empty()
            || value
                .bytes()
                .any(|b| b.is_ascii_whitespace() || b.is_ascii_control())
        {
            return Err(Error::Invalid("凭据为空或包含空白/控制字符".into()));
        }
        Ok(Self(value))
    }
    pub fn from_env(name: &str) -> Result<Self> {
        let file = std::env::var(format!("{name}_FILE")).ok();
        match (std::env::var(name).ok(), file) {
            (Some(_), Some(_)) => Err(Error::Invalid(format!(
                "{name} 与 {name}_FILE 只能设置一个"
            ))),
            (Some(value), None) => Self::new(value),
            (None, Some(file)) => Self::new(std::fs::read_to_string(file)?),
            _ => Err(Error::Invalid(format!("需要 {name} 或 {name}_FILE"))),
        }
    }
    pub fn redact(&self, text: &str) -> String {
        text.replace(&self.0, "[REDACTED]")
    }
    pub fn redact_json(&self, value: &Value) -> Value {
        match value {
            Value::String(text) => Value::String(self.redact(text)),
            Value::Array(items) => {
                Value::Array(items.iter().map(|item| self.redact_json(item)).collect())
            }
            Value::Object(object) => Value::Object(
                object
                    .iter()
                    .map(|(key, value)| (self.redact(key), self.redact_json(value)))
                    .collect(),
            ),
            value => value.clone(),
        }
    }
}

pub struct Gateway {
    base: reqwest::Url,
    key: Secret,
    http: reqwest::Client,
}
impl Gateway {
    pub fn new(url: &str, key: Secret, timeout: Duration) -> Result<Self> {
        let base = checked_url(url, &["http", "https"])?;
        let http = reqwest::Client::builder()
            .timeout(timeout)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| Error::Transport)?;
        Ok(Self { base, key, http })
    }
    pub async fn request(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value> {
        if !path.starts_with("/api/v1/") || path.contains(['?', '#']) {
            return Err(Error::Invalid("无效 Gateway 路径".into()));
        }
        let mut url = self.base.clone();
        url.set_path(path);
        let mut request = self.http.request(method, url).bearer_auth(&self.key.0);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.map_err(|_| Error::Transport)?;
        let status = response.status();
        let body: Value = response
            .json()
            .await
            .map_err(|_| Error::Protocol("Gateway 响应不是 JSON".into()))?;
        if !status.is_success() {
            return Err(Error::Gateway {
                status: status.as_u16(),
                code: self
                    .key
                    .redact(body["error"]["code"].as_str().unwrap_or("unknown")),
            });
        }
        // 即使对端意外回显身份，也不把身份交给输出层。
        Ok(self.key.redact_json(&body))
    }
}

fn checked_url(url: &str, schemes: &[&str]) -> Result<reqwest::Url> {
    let url = reqwest::Url::parse(url).map_err(|_| Error::Invalid("URL 无效".into()))?;
    if !schemes.contains(&url.scheme())
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(Error::Invalid(
            "URL 必须使用支持的协议，且不能含凭据、query 或 fragment".into(),
        ));
    }
    Ok(url)
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptOutcome {
    Completed,
    Cancelled,
}
impl PromptOutcome {
    pub fn from_result(result: &Value) -> Result<Self> {
        match result["stopReason"].as_str() {
            Some("end_turn") => Ok(Self::Completed),
            Some("cancelled") => Ok(Self::Cancelled),
            _ => Err(Error::Protocol(
                "prompt 缺少已知 stopReason，不能判为成功".into(),
            )),
        }
    }
}

/// 每条连接串行发送请求。通知不完成请求，只有同 ID 的响应能完成请求。
/// 另一个连接可取消/查询同一身份下的会话。断线不重试 prompt。
pub struct Acp {
    socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
    token: Secret,
    next_id: u64,
    timeout: Duration,
}
impl Acp {
    pub async fn connect(url: &str, token: Secret, timeout: Duration) -> Result<Self> {
        let url = checked_url(url, &["ws", "wss"])?;
        let mut request = url
            .as_str()
            .into_client_request()
            .map_err(|_| Error::Invalid("ACP URL 无效".into()))?;
        let mut auth = format!("Bearer {}", token.0)
            .parse::<tokio_tungstenite::tungstenite::http::HeaderValue>()
            .map_err(|_| Error::Invalid("session token 无效".into()))?;
        auth.set_sensitive(true);
        request.headers_mut().insert("Authorization", auth);
        let config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default()
            .max_message_size(Some(1024 * 1024))
            .max_frame_size(Some(1024 * 1024));
        let (socket, _) = tokio::time::timeout(
            timeout,
            tokio_tungstenite::connect_async_with_config(request, Some(config), false),
        )
        .await
        .map_err(|_| Error::Timeout)?
        .map_err(|_| Error::Transport)?;
        Ok(Self {
            socket,
            token,
            next_id: 1,
            timeout,
        })
    }
    pub async fn initialize(&mut self) -> Result<Value> {
        let result = self
            .request(
                "initialize",
                json!({"protocolVersion":1,"clientCapabilities":{}}),
                |_| {},
            )
            .await?;
        if result["protocolVersion"] != 1 {
            return Err(Error::Protocol("ACP 协议版本不支持".into()));
        }
        Ok(result)
    }
    pub async fn notify(&mut self, method: &str, params: Value) -> Result<()> {
        tokio::time::timeout(
            self.timeout,
            self.socket.send(Message::Text(
                json!({"jsonrpc":"2.0","method":method,"params":params})
                    .to_string()
                    .into(),
            )),
        )
        .await
        .map_err(|_| Error::Timeout)?
        .map_err(|_| Error::Transport)
    }
    pub async fn request(
        &mut self,
        method: &str,
        params: Value,
        mut on_update: impl FnMut(Value),
    ) -> Result<Value> {
        let id = self.next_id;
        self.next_id = self
            .next_id
            .checked_add(1)
            .ok_or_else(|| Error::Protocol("请求 ID 耗尽".into()))?;
        let deadline = Instant::now() + self.timeout;
        timeout_at(
            deadline,
            self.socket.send(Message::Text(
                json!({"jsonrpc":"2.0","id":id,"method":method,"params":params})
                    .to_string()
                    .into(),
            )),
        )
        .await
        .map_err(|_| Error::Timeout)?
        .map_err(|_| Error::Transport)?;
        loop {
            if Instant::now() >= deadline {
                return Err(Error::Timeout);
            }
            let message = timeout_at(deadline, self.socket.next())
                .await
                .map_err(|_| Error::Timeout)?
                .ok_or(Error::Closed)?
                .map_err(|_| Error::Transport)?;
            let text = match message {
                Message::Text(text) => text,
                Message::Ping(data) => {
                    timeout_at(deadline, self.socket.send(Message::Pong(data)))
                        .await
                        .map_err(|_| Error::Timeout)?
                        .map_err(|_| Error::Transport)?;
                    continue;
                }
                Message::Pong(_) => continue,
                Message::Close(_) => return Err(Error::Closed),
                _ => return Err(Error::Protocol("ACP 需要文本 JSON 消息".into())),
            };
            let value: Value =
                serde_json::from_str(&text).map_err(|_| Error::Protocol("ACP JSON 无效".into()))?;
            if value["jsonrpc"] != "2.0" {
                return Err(Error::Protocol("JSON-RPC 版本无效".into()));
            }
            if value.get("id").is_none() && value["method"] == "session/update" {
                on_update(self.token.redact_json(&value["params"]));
                continue;
            }
            if value["id"] != json!(id) {
                continue;
            }
            if value.get("result").is_some() == value.get("error").is_some() {
                return Err(Error::Protocol("响应必须只包含 result 或 error".into()));
            }
            if let Some(error) = value.get("error") {
                return Err(Error::Rpc {
                    code: error["code"].as_i64().unwrap_or(-32000),
                    message: self
                        .token
                        .redact(error["message"].as_str().unwrap_or("远端执行失败")),
                });
            }
            return Ok(self.token.redact_json(&value["result"]));
        }
    }
}

/// SSH 与 SFTP 共用专用 known_hosts。首次连接 TOFU，后续主机密钥变更拒绝。
pub struct Ssh {
    pub host: String,
    pub port: u16,
    pub identity: std::path::PathBuf,
    pub known_hosts: std::path::PathBuf,
    pub timeout: Duration,
}
impl Ssh {
    fn command(&self, sftp: bool) -> Result<tokio::process::Command> {
        if self.host.is_empty()
            || self.host.starts_with('-')
            || self.host.contains(['\n', '\r', '@', '/', ' '])
        {
            return Err(Error::Invalid("SSH host 无效".into()));
        }
        let mut cmd = tokio::process::Command::new(if sftp { "sftp" } else { "ssh" });
        cmd.kill_on_drop(true)
            .args([
                "-F",
                "/dev/null",
                "-o",
                "BatchMode=yes",
                "-o",
                "IdentitiesOnly=yes",
                "-o",
                "PasswordAuthentication=no",
                "-o",
                "KbdInteractiveAuthentication=no",
                "-o",
                "StrictHostKeyChecking=accept-new",
                "-o",
                "ConnectTimeout=10",
                "-o",
                "ServerAliveInterval=10",
                "-o",
                "ServerAliveCountMax=2",
                "-o",
                "GlobalKnownHostsFile=/dev/null",
            ])
            .arg("-o")
            .arg(format!("UserKnownHostsFile={}", self.known_hosts.display()))
            .arg("-i")
            .arg(&self.identity)
            .arg(if sftp { "-P" } else { "-p" })
            .arg(self.port.to_string());
        if sftp {
            cmd.args(["-b", "-"]);
        }
        cmd.arg(format!("agent@{}", self.host));
        Ok(cmd)
    }
    pub async fn run(&self, script: &[u8]) -> Result<std::process::Output> {
        let mut command = self.command(false)?;
        command.args(["sh", "-se"]);
        self.execute(command, script).await
    }
    pub async fn transfer(
        &self,
        upload: bool,
        local: &Path,
        remote: &str,
    ) -> Result<std::process::Output> {
        fn quoted(value: &str) -> Result<String> {
            if value.contains(['\n', '\r', '\0']) {
                return Err(Error::Invalid("SFTP 路径含换行或 NUL".into()));
            }
            Ok(format!(
                "\"{}\"",
                value.replace('\\', "\\\\").replace('"', "\\\"")
            ))
        }
        let local = quoted(
            local
                .to_str()
                .ok_or_else(|| Error::Invalid("路径需要 UTF-8".into()))?,
        )?;
        let remote = quoted(remote)?;
        let script = if upload {
            format!("put {local} {remote}\n")
        } else {
            format!("get {remote} {local}\n")
        };
        self.execute(self.command(true)?, script.as_bytes()).await
    }
    async fn execute(
        &self,
        mut command: tokio::process::Command,
        input: &[u8],
    ) -> Result<std::process::Output> {
        use std::process::Stdio;
        use tokio::io::AsyncWriteExt;
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn()?;
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| Error::Invalid("缺少子进程 stdin".into()))?;
        tokio::time::timeout(self.timeout, async {
            // 同时排空输出，避免大量 SFTP/SSH 输出阻塞 stdin。
            let write = async move {
                stdin.write_all(input).await?;
                stdin.shutdown().await?;
                drop(stdin);
                Ok::<_, std::io::Error>(())
            };
            let (written, output) = tokio::join!(write, child.wait_with_output());
            written?;
            output.map_err(Error::Io)
        })
        .await
        .map_err(|_| Error::Timeout)?
    }
}
