//! Gateway 控制面、TCP bridge 和 SSH/SFTP 客户端。
#[cfg(feature = "acp")]
#[path = "../consumers/acp/mod.rs"]
pub mod acp;
#[cfg(feature = "acp")]
pub use acp::{Acp, PromptOutcome};

use std::{net::SocketAddr, path::Path, sync::Arc, time::Duration};

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, split},
    net::{TcpListener, TcpStream},
    sync::watch,
};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream,
    tungstenite::{Message, client::IntoClientRequest, http::header},
};

const TCP_SUBPROTOCOL: &str = "ursi-tcp-v1";
const MAX_TCP_MESSAGE: usize = 64 * 1024;

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
    #[cfg(feature = "acp")]
    #[error("ACP 错误 {code}: {message}")]
    Rpc { code: i64, message: String },
    #[error("连接关闭，远端任务可能仍运行")]
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
    key: Arc<Secret>,
    http: reqwest::Client,
    timeout: Duration,
}
impl Clone for Gateway {
    fn clone(&self) -> Self {
        Self {
            base: self.base.clone(),
            key: Arc::clone(&self.key),
            http: self.http.clone(),
            timeout: self.timeout,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Endpoint {
    pub name: String,
    pub bundle: String,
    pub protocol: String,
    pub port: u16,
    pub state: String,
    pub ready: bool,
}
impl Gateway {
    pub fn new(url: &str, key: Secret, timeout: Duration) -> Result<Self> {
        let base = checked_url(url, &["http", "https"])?;
        let http = reqwest::Client::builder()
            .timeout(timeout)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| Error::Transport)?;
        Ok(Self {
            base,
            key: Arc::new(key),
            http,
            timeout,
        })
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

    pub async fn endpoints(&self, sandbox_id: &str) -> Result<Vec<Endpoint>> {
        validate_identifier(sandbox_id, "沙箱 ID")?;
        let value = self
            .request(
                reqwest::Method::GET,
                &format!("/api/v1/sandboxes/{sandbox_id}/endpoints"),
                None,
            )
            .await?;
        serde_json::from_value(value["endpoints"].clone())
            .map_err(|_| Error::Protocol("Gateway 端点响应无效".into()))
    }

    pub async fn bridge(
        &self,
        sandbox_id: &str,
        endpoint_name: &str,
        listen: SocketAddr,
    ) -> Result<Bridge> {
        self.ready_endpoint(sandbox_id, endpoint_name).await?;
        Ok(Bridge {
            gateway: self.clone(),
            sandbox_id: sandbox_id.to_owned(),
            endpoint_name: endpoint_name.to_owned(),
            listener: TcpListener::bind(listen).await?,
        })
    }

    async fn ready_endpoint(&self, sandbox_id: &str, endpoint_name: &str) -> Result<Endpoint> {
        validate_identifier(sandbox_id, "沙箱 ID")?;
        validate_identifier(endpoint_name, "端点名")?;
        let endpoint = self
            .endpoints(sandbox_id)
            .await?
            .into_iter()
            .find(|endpoint| endpoint.name == endpoint_name)
            .ok_or_else(|| Error::Invalid("端点不存在".into()))?;
        if !endpoint.ready || endpoint.state != "ready" {
            return Err(Error::Invalid("端点尚未就绪".into()));
        }
        Ok(endpoint)
    }

    /// 把本地 stdin/stdout 直通到逻辑端点，作为 SSH `ProxyCommand` 使用。
    /// stdout 只承载隧道字节，不输出任何结构化结果。
    pub async fn proxy_stdio(&self, sandbox_id: &str, endpoint_name: &str) -> Result<()> {
        self.ready_endpoint(sandbox_id, endpoint_name).await?;
        let websocket = self.connect_tunnel(sandbox_id, endpoint_name).await?;
        relay_stream(
            tokio::io::join(tokio::io::stdin(), tokio::io::stdout()),
            websocket,
        )
        .await
    }

    async fn connect_tunnel(
        &self,
        sandbox_id: &str,
        endpoint_name: &str,
    ) -> Result<WebSocketStream<MaybeTlsStream<TcpStream>>> {
        let mut url = self.base.clone();
        url.set_scheme(match url.scheme() {
            "http" => "ws",
            "https" => "wss",
            _ => return Err(Error::Invalid("Gateway URL 协议无效".into())),
        })
        .map_err(|_| Error::Invalid("Gateway URL 协议无效".into()))?;
        {
            let mut segments = url
                .path_segments_mut()
                .map_err(|_| Error::Invalid("Gateway URL 路径无效".into()))?;
            segments.clear();
            segments.extend([
                "api",
                "v1",
                "sandboxes",
                sandbox_id,
                "connect",
                endpoint_name,
            ]);
        }
        let mut request = url
            .as_str()
            .into_client_request()
            .map_err(|_| Error::Invalid("Gateway WebSocket URL 无效".into()))?;
        let mut auth = format!("Bearer {}", self.key.0)
            .parse::<tokio_tungstenite::tungstenite::http::HeaderValue>()
            .map_err(|_| Error::Invalid("Gateway key 无效".into()))?;
        auth.set_sensitive(true);
        request.headers_mut().insert(header::AUTHORIZATION, auth);
        request.headers_mut().insert(
            header::SEC_WEBSOCKET_PROTOCOL,
            tokio_tungstenite::tungstenite::http::HeaderValue::from_static(TCP_SUBPROTOCOL),
        );
        let config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default()
            .max_message_size(Some(MAX_TCP_MESSAGE))
            .max_frame_size(Some(MAX_TCP_MESSAGE));
        tokio::time::timeout(
            self.timeout(),
            tokio_tungstenite::connect_async_with_config(request, Some(config), false),
        )
        .await
        .map_err(|_| Error::Timeout)?
        .map(|(socket, _)| socket)
        .map_err(|_| Error::Transport)
    }

    fn timeout(&self) -> Duration {
        self.timeout
    }
}

pub struct Bridge {
    gateway: Gateway,
    sandbox_id: String,
    endpoint_name: String,
    listener: TcpListener,
}

impl Bridge {
    pub fn local_addr(&self) -> Result<SocketAddr> {
        Ok(self.listener.local_addr()?)
    }

    /// 接受本地 TCP 连接，直到 cancel 收到 true。每个连接使用独立 Gateway WebSocket。
    pub async fn run_until(self, mut cancel: watch::Receiver<bool>) -> Result<()> {
        let Bridge {
            gateway,
            sandbox_id,
            endpoint_name,
            listener,
        } = self;
        let mut tasks = tokio::task::JoinSet::new();
        loop {
            tokio::select! {
                changed = cancel.changed() => {
                    if changed.is_err() || *cancel.borrow() {
                        tasks.abort_all();
                        while tasks.join_next().await.is_some() {}
                        return Ok(());
                    }
                }
                _ = tasks.join_next(), if !tasks.is_empty() => {}
                accepted = listener.accept() => {
                    let (tcp, _) = accepted?;
                    let gateway = gateway.clone();
                    let sandbox_id = sandbox_id.clone();
                    let endpoint_name = endpoint_name.clone();
                    tasks.spawn(async move {
                        let _ = relay_connection(
                            tcp,
                            gateway,
                            &sandbox_id,
                            &endpoint_name,
                        ).await;
                    });
                }
            }
        }
    }
}

async fn relay_connection(
    tcp: TcpStream,
    gateway: Gateway,
    sandbox_id: &str,
    endpoint_name: &str,
) -> Result<()> {
    let websocket = gateway.connect_tunnel(sandbox_id, endpoint_name).await?;
    relay_stream(tcp, websocket).await
}

/// 双向中继一个本地字节流与一条 Gateway 隧道，保持 `eof` 半关闭与 Ping 保活语义。
///
/// 本地读放在独立任务里，避免 `select!` 取消挂起的读 future。`tokio::io::stdin`
/// 的读由阻塞池完成，取消挂起的读会丢失已读字节。
async fn relay_stream<S>(
    stream: S,
    websocket: WebSocketStream<MaybeTlsStream<TcpStream>>,
) -> Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (mut local_read, mut local_write) = split(stream);
    let (mut ws_write, mut ws_read) = websocket.split();
    let (chunks, mut incoming) = tokio::sync::mpsc::channel::<Vec<u8>>(4);
    let reader = tokio::spawn(async move {
        let mut buffer = vec![0u8; MAX_TCP_MESSAGE];
        loop {
            match local_read.read(&mut buffer).await {
                Ok(0) | Err(_) => return,
                Ok(count) => {
                    if chunks.send(buffer[..count].to_vec()).await.is_err() {
                        return;
                    }
                }
            }
        }
    });
    let mut local_eof = false;
    let mut remote_eof = false;
    let mut ping = tokio::time::interval_at(
        tokio::time::Instant::now() + Duration::from_secs(20),
        Duration::from_secs(20),
    );
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        if local_eof && remote_eof {
            let _ = ws_write.send(Message::Close(None)).await;
            break;
        }
        tokio::select! {
            chunk = incoming.recv(), if !local_eof => {
                match chunk {
                    Some(bytes) => {
                        ws_write.send(Message::Binary(bytes.into())).await.map_err(|_| Error::Transport)?;
                    }
                    None => {
                        ws_write.send(Message::Text("eof".into())).await.map_err(|_| Error::Transport)?;
                        local_eof = true;
                    }
                }
            }
            message = ws_read.next(), if !remote_eof => {
                let message = message.ok_or(Error::Closed)?.map_err(|_| Error::Transport)?;
                match message {
                    Message::Binary(bytes) if bytes.len() <= MAX_TCP_MESSAGE => {
                        local_write.write_all(&bytes).await?;
                        // 本地写端可能是行缓冲的标准输出，SSH 报文不含换行时必须显式 flush。
                        local_write.flush().await?;
                    }
                    Message::Text(text) if text == "eof" => {
                        local_write.shutdown().await?;
                        remote_eof = true;
                    }
                    Message::Ping(payload) => {
                        ws_write.send(Message::Pong(payload)).await.map_err(|_| Error::Transport)?;
                    }
                    Message::Pong(_) => {}
                    Message::Close(_) => break,
                    Message::Binary(_) | Message::Text(_) => {
                        return Err(Error::Protocol("ursi-tcp-v1 消息超限或无效".into()));
                    }
                    _ => return Err(Error::Protocol("ursi-tcp-v1 消息无效".into())),
                }
            }
            _ = ping.tick() => {
                ws_write.send(Message::Ping(Vec::new().into())).await.map_err(|_| Error::Transport)?;
            }
        }
    }
    reader.abort();
    let _ = reader.await;
    Ok(())
}

fn validate_identifier(value: &str, label: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err(Error::Invalid(format!("{label} 无效")));
    }
    Ok(())
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
