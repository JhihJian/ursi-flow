use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use russh::client::{self, Handler};
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg};
use russh::{ChannelMsg, ChannelReadHalf, ChannelWriteHalf, Disconnect};
use tokio::sync::mpsc;

use crate::db::Connection as ConnectionConfig;
use crate::models::{AuthType, TmuxSession};

/// 连接超时：主机不可达时不能无限等待。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// SSH 输出转发通道容量：读方向靠 SSH 流控窗口反压，这里只缓冲少量事件。
pub const EVENT_CAPACITY: usize = 32;
/// WS 输入通道容量。
pub const INPUT_CAPACITY: usize = 32;
/// 单条 WS 输入消息的 JSON 字节上限，超出视为恶意或异常客户端。
pub const WS_TEXT_LIMIT_BYTES: usize = 64 * 1024;
/// PTY 尺寸上限，与前端一致。
const MAX_COLS: u32 = 500;
const MAX_ROWS: u32 = 500;
/// 默认 tmux 会话名：远端有 tmux 时 attach 的固定会话。
pub const DEFAULT_TMUX_SESSION: &str = "ssh-main";

/// tmux 会话名白名单：ASCII 字母数字下划线连字符，1-64 字符。
/// 拒绝一切其他字符，杜绝拼进远端命令的注入面。
pub fn valid_tmux_session(name: &str) -> bool {
    (1..=64).contains(&name.len())
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

#[derive(Debug)]
struct ClientHandler;

impl Handler for ClientHandler {
    type Error = anyhow::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        // 内网个人工具，不做 known_hosts 校验；边界决策记录在 SPEC。
        Ok(true)
    }
}

fn client_config() -> Arc<client::Config> {
    Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(120)),
        keepalive_interval: Some(Duration::from_secs(15)),
        ..Default::default()
    })
}

/// 泵任务发给 WS 任务的事件。Data 走 binary 帧，其余转 JSON 文本帧。
#[derive(Debug)]
pub enum WsEvent {
    /// 终端输出字节流，原样下发，不做 String 转换。
    Data(Bytes),
    /// 会话建立或运行失败，message 面向用户展示。
    Error { message: String },
    /// SSH 侧断开，前端据此把终端标记为已结束。
    Closed { message: String },
}

/// WS 发来的控制消息。
#[derive(Debug)]
pub enum ControlMessage {
    Input(String),
    Resize { cols: u32, rows: u32 },
}

/// 远端启动命令：tmux 可用则 attach 指定会话（不存在则创建），
/// 否则回退普通 shell 并在终端里打一行提示。
/// 会话名已过白名单，单引号内拼接安全。保持 POSIX sh 兼容。
fn start_command(tmux_session: &str) -> String {
    format!(
        r"command -v tmux >/dev/null 2>&1 && tmux new -A -s '{name}' || {{ printf '\033[33m[ssh-web] 远端无 tmux，已回退普通 shell，断开后会话不保留\033[0m\n'; exec $SHELL; }}",
        name = tmux_session
    )
}

/// 终端任务：连接、认证、开 PTY、执行启动命令、泵数据。
/// 建立或运行失败经 event_tx 发 Error；正常退出发 Closed。
/// 随调用方（WS 循环）取消而结束，SSH 连接随任务 drop 断开。
pub async fn run_terminal(
    connection: ConnectionConfig,
    tmux_session: Option<String>,
    cols: u32,
    rows: u32,
    mut input_rx: mpsc::Receiver<ControlMessage>,
    event_tx: mpsc::Sender<WsEvent>,
) {
    if let Err(error) =
        run_terminal_inner(&connection, tmux_session, cols, rows, &mut input_rx, &event_tx).await
    {
        let _ = event_tx
            .send(WsEvent::Error {
                message: format!("{error:#}"),
            })
            .await;
    }
}

async fn run_terminal_inner(
    connection: &ConnectionConfig,
    tmux_session: Option<String>,
    cols: u32,
    rows: u32,
    input_rx: &mut mpsc::Receiver<ControlMessage>,
    event_tx: &mpsc::Sender<WsEvent>,
) -> anyhow::Result<()> {
    let config = client_config();
    let handle = tokio::time::timeout(CONNECT_TIMEOUT, connect_and_auth(&config, connection))
        .await
        .map_err(|_| anyhow::anyhow!("连接超时"))??;

    // 初始 PTY 尺寸由 WS 查询参数带入，与前端面板实际大小一致，无 80×24 闪排。
    let channel = handle.channel_open_session().await?;
    channel
        .request_pty(false, "xterm-256color", cols, rows, 0, 0, &[])
        .await?;
    let name = tmux_session.unwrap_or_else(|| DEFAULT_TMUX_SESSION.to_string());
    channel.exec(false, start_command(&name).as_str()).await?;

    let (mut read_half, write_half) = channel.split();
    let result = pump(&mut read_half, &write_half, input_rx, event_tx).await;
    // 事件通道随 WS 循环一起结束；断开 SSH（远端 tmux client 退出，tmux 会话保留）。
    let _ = handle
        .disconnect(Disconnect::ByApplication, "session closed", "en")
        .await;
    match result {
        Ok(message) => {
            let _ = event_tx.send(WsEvent::Closed { message }).await;
            Ok(())
        }
        Err(error) => Err(error),
    }
}

/// 连接并认证，失败原因面向用户。
async fn connect_and_auth(
    config: &Arc<client::Config>,
    connection: &ConnectionConfig,
) -> anyhow::Result<client::Handle<ClientHandler>> {
    let mut handle = client::connect(
        Arc::clone(config),
        (connection.host.as_str(), connection.port as u16),
        ClientHandler,
    )
    .await?;
    let authed = match connection.auth_type {
        AuthType::Password => {
            let password = connection.password.as_deref().context_("连接缺少密码")?;
            handle
                .authenticate_password(&connection.username, password)
                .await?
        }
        AuthType::Key => {
            let key_path = connection
                .key_path
                .as_deref()
                .context_("连接缺少私钥路径")?;
            let key = load_secret_key(key_path, connection.key_passphrase.as_deref())?;
            handle
                .authenticate_publickey(
                    &connection.username,
                    PrivateKeyWithHashAlg::new(Arc::new(key), None),
                )
                .await?
        }
    };
    if !authed.success() {
        anyhow::bail!("认证失败：{}", connection.username);
    }
    Ok(handle)
}

/// 数据泵：SSH 与 WS 之间的双向转发。
///
/// - SSH → WS：`ChannelMsg::Data`/`ExtendedData` 原样转 binary 帧，
///   不做 String 转换，避免 UTF-8 跨 chunk 截断。
/// - WS → SSH：input 文本直接 `data_bytes` 写入；resize 调 `window_change`。
/// - 两路任一退出即整体退出：WS 关闭（event_tx 发送失败）或 SSH 关闭。
async fn pump(
    read_half: &mut ChannelReadHalf,
    write_half: &ChannelWriteHalf<client::Msg>,
    input_rx: &mut mpsc::Receiver<ControlMessage>,
    event_tx: &mpsc::Sender<WsEvent>,
) -> anyhow::Result<String> {
    loop {
        tokio::select! {
            message = read_half.wait() => {
                match message {
                    Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                        event_tx.send(WsEvent::Data(data)).await.context_("WS 已关闭")?;
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => {
                        return Ok(format!("远端退出，exit code {exit_status}"));
                    }
                    Some(ChannelMsg::ExitSignal { signal_name, .. }) => {
                        return Ok(format!("远端退出，signal {signal_name:?}"));
                    }
                    Some(_) => {}
                    None => return Ok("SSH 通道已关闭".into()),
                }
            }
            control = input_rx.recv() => {
                match control {
                    Some(ControlMessage::Input(data)) => {
                        write_half.data_bytes(data.into_bytes()).await?;
                    }
                    Some(ControlMessage::Resize { cols, rows }) => {
                        write_half.window_change(cols.min(MAX_COLS), rows.min(MAX_ROWS), 0, 0).await?;
                    }
                    None => return Ok("WS 输入通道已关闭".into()),
                }
            }
        }
    }
}

/// 在远端执行一条命令，收集 stdout 与退出码后断开。
async fn exec_collect(
    connection: &ConnectionConfig,
    command: &str,
) -> anyhow::Result<(String, Option<u32>)> {
    let config = client_config();
    let handle = tokio::time::timeout(CONNECT_TIMEOUT, connect_and_auth(&config, connection))
        .await
        .map_err(|_| anyhow::anyhow!("连接超时"))??;
    let mut channel = handle.channel_open_session().await?;
    channel.exec(false, command).await?;
    let mut out = Vec::new();
    let mut exit_code = None;
    loop {
        match channel.wait().await {
            Some(ChannelMsg::Data { data }) => out.extend_from_slice(&data),
            // stderr 丢弃：错误用退出码表达。
            Some(ChannelMsg::ExtendedData { .. }) => {}
            Some(ChannelMsg::ExitStatus { exit_status }) => exit_code = Some(exit_status),
            Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) => {}
            Some(_) => {}
            None => break,
        }
    }
    let _ = handle
        .disconnect(Disconnect::ByApplication, "done", "en")
        .await;
    Ok((String::from_utf8_lossy(&out).into_owned(), exit_code))
}

/// 列出远端 tmux 会话。远端没有 tmux 时返回 None（前端据此展示回退提示）。
/// tmux 无会话（exit 1）是正常空态。
pub async fn list_tmux_sessions(
    connection: &ConnectionConfig,
) -> anyhow::Result<Option<Vec<TmuxSession>>> {
    let (out, code) = exec_collect(
        connection,
        // tmux 的 -F 格式串不解析 \t 转义（输出字面反斜杠），用竖线做字段分隔。
        // 竖线不在会话名白名单里，不会冲突。
        "tmux ls -F '#{session_name}|#{session_attached}|#{session_created}' 2>/dev/null",
    )
    .await?;
    match code {
        Some(0) => {
            let sessions = out
                .lines()
                .filter_map(|line| {
                    let mut parts = line.splitn(3, '|');
                    Some(TmuxSession {
                        name: parts.next()?.to_string(),
                        attached: parts.next()?.parse().unwrap_or(0),
                        created: parts.next()?.parse().unwrap_or(0),
                    })
                })
                .collect();
            Ok(Some(sessions))
        }
        Some(1) => Ok(Some(Vec::new())),
        // 127 = tmux 不存在。
        Some(127) => Ok(None),
        code => anyhow::bail!("tmux ls 异常退出：{code:?}"),
    }
}

/// `anyhow::Context` 对 Option 不可用，这里补一个同语义的小工具。
trait Context_<T> {
    fn context_(self, message: &str) -> anyhow::Result<T>;
}

impl<T, E: std::fmt::Display> Context_<T> for Result<T, E> {
    fn context_(self, message: &str) -> anyhow::Result<T> {
        self.map_err(|error| anyhow::anyhow!("{message}: {error}"))
    }
}

impl<T> Context_<T> for Option<T> {
    fn context_(self, message: &str) -> anyhow::Result<T> {
        self.ok_or_else(|| anyhow::anyhow!("{message}"))
    }
}
