use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use russh::client::{self, Handler};
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg};
use russh::{ChannelMsg, ChannelReadHalf, ChannelWriteHalf, Disconnect};
use serde::Serialize;
use tokio::sync::{mpsc, oneshot, Mutex};

use crate::db::Connection as ConnectionConfig;
use crate::models::AuthType;

/// 连接超时：主机不可达时不能无限等待。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// WS 输入事件通道容量：读方向靠 SSH 流控窗口反压，这里只缓冲少量事件。
pub const WS_INPUT_CAPACITY: usize = 32;
/// 单条 WS 输入消息的 JSON 字节上限，超出视为恶意或异常客户端。
const WS_TEXT_LIMIT: usize = 64 * 1024;
/// PTY 尺寸上限，与前端一致。
const MAX_COLS: u32 = 500;
const MAX_ROWS: u32 = 500;

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

#[derive(Debug, Clone, Serialize)]
pub struct SessionInfo {
    pub id: String,
    pub connection_id: i64,
    pub connection_name: String,
    pub host: String,
    pub username: String,
    /// WS 已接入后为 true。建立与接入之间会话处于待接入状态。
    pub attached: bool,
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

pub struct Attach {
    pub input_rx: mpsc::Receiver<ControlMessage>,
    pub event_tx: mpsc::Sender<WsEvent>,
}

/// 会话任务的控制通道。oneshot::send 需要所有权，
/// 所以放 std::sync::Mutex 里，用完即取走。
struct SessionControl {
    close_tx: Option<oneshot::Sender<()>>,
    attach_tx: Option<oneshot::Sender<Attach>>,
}

/// 会话建立结果：SSH 连接、认证与 shell 就绪后发给 connect 调用方。
type ReadySignal = oneshot::Sender<Result<(), String>>;

/// 会话任务的通道集合：WS 接入、主动关闭与建立结果。
struct SessionPipes {
    attach_rx: oneshot::Receiver<Attach>,
    close_rx: oneshot::Receiver<()>,
    ready_tx: Option<ReadySignal>,
}

/// 注册表里的一条会话：元信息与控制通道。任务自行结束，句柄不保留。
struct SessionEntry {
    info: std::sync::Mutex<SessionInfo>,
    control: std::sync::Mutex<SessionControl>,
}

/// 会话注册表。会话随服务进程存活，重启即失。
#[derive(Default)]
pub struct SessionRegistry {
    sessions: Mutex<HashMap<String, SessionEntry>>,
}

impl SessionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// 发起 SSH 连接并注册会话，返回后即可通过 `/api/sessions/{id}/ws` 接入。
    /// 失败时返回面向用户的错误消息。
    pub async fn connect(
        &self,
        config: &ConnectionConfig,
        cols: u32,
        rows: u32,
    ) -> Result<SessionInfo, String> {
        let id = new_session_id();
        let (close_tx, close_rx) = oneshot::channel();
        let (attach_tx, attach_rx) = oneshot::channel();
        let (ready_tx, ready_rx) = oneshot::channel::<Result<(), String>>();
        let info = SessionInfo {
            id: id.clone(),
            connection_id: config.id,
            connection_name: config.name.clone(),
            host: config.host.clone(),
            username: config.username.clone(),
            attached: false,
        };

        let task_config = client_config();
        let task_connection = config.clone();
        let task_id = id.clone();
        let pipes = SessionPipes {
            attach_rx,
            close_rx,
            ready_tx: Some(ready_tx),
        };
        tokio::spawn(run_session(
            task_config,
            task_connection,
            task_id,
            cols,
            rows,
            pipes,
        ));

        self.sessions.lock().await.insert(
            id.clone(),
            SessionEntry {
                info: std::sync::Mutex::new(info.clone()),
                control: std::sync::Mutex::new(SessionControl {
                    close_tx: Some(close_tx),
                    attach_tx: Some(attach_tx),
                }),
            },
        );

        // 等 SSH 建立+认证完成再返回，失败原因直接给调用方。
        match ready_rx.await {
            Ok(Ok(())) => Ok(info),
            Ok(Err(message)) => {
                self.remove(&id).await;
                Err(message)
            }
            Err(_) => {
                self.remove(&id).await;
                Err("会话任务异常退出".into())
            }
        }
    }

    pub async fn list(&self) -> Vec<SessionInfo> {
        let sessions = self.sessions.lock().await;
        let mut infos: Vec<SessionInfo> = sessions
            .values()
            .map(|entry| entry.info.lock().expect("会话信息锁").clone())
            .collect();
        infos.sort_by(|a, b| a.id.cmp(&b.id));
        infos
    }

    pub async fn get(&self, id: &str) -> Option<SessionInfo> {
        self.sessions
            .lock()
            .await
            .get(id)
            .map(|entry| entry.info.lock().expect("会话信息锁").clone())
    }

    /// WS 接入：把泵任务的两端交给会话任务。会话可能已失败退出，
    /// 此时接入失败返回 false。
    pub async fn attach(&self, id: &str, attach: Attach) -> bool {
        let sessions = self.sessions.lock().await;
        let Some(entry) = sessions.get(id) else {
            return false;
        };
        let attach_tx = entry.control.lock().expect("会话控制锁").attach_tx.take();
        match attach_tx {
            Some(attach_tx) => {
                if attach_tx.send(attach).is_ok() {
                    entry.info.lock().expect("会话信息锁").attached = true;
                    true
                } else {
                    false
                }
            }
            None => false,
        }
    }

    /// 主动关闭：通知会话任务退出并从注册表移除。
    pub async fn close(&self, id: &str) -> bool {
        let entry = self.sessions.lock().await.remove(id);
        match entry {
            Some(entry) => {
                let close_tx = entry.control.lock().expect("会话控制锁").close_tx.take();
                if let Some(close_tx) = close_tx {
                    let _ = close_tx.send(());
                }
                true
            }
            None => false,
        }
    }

    /// 会话任务结束后清理注册项。
    pub async fn remove(&self, id: &str) {
        self.sessions.lock().await.remove(id);
    }
}

/// 会话 ID：时间戳加进程内计数，避免引入 uuid 依赖。
fn new_session_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let count = COUNTER.fetch_add(1, Ordering::Relaxed);
    let time = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("s-{time:032x}-{count:016x}")
}

/// 会话主任务：建立 SSH 连接与 shell，等待 WS 接入，然后驱动泵任务；
/// 任何一步失败都会把错误发给接入方（或打印后退出），结束时断开 SSH。
/// 会话主任务：建立 SSH 连接与 shell，等待 WS 接入，然后驱动数据泵；
/// 结束时从注册表移除自己并断开 SSH。
async fn run_session(
    config: Arc<client::Config>,
    connection: ConnectionConfig,
    id: String,
    cols: u32,
    rows: u32,
    pipes: SessionPipes,
) {
    let registry_id = id.clone();
    if let Err(error) = run_session_inner(&config, &connection, &id, cols, rows, pipes).await {
        println!("会话 {id} 异常结束：{error:#}");
    }
    crate::app::app_state().registry.remove(&registry_id).await;
}

async fn run_session_inner(
    config: &Arc<client::Config>,
    connection: &ConnectionConfig,
    id: &str,
    cols: u32,
    rows: u32,
    mut pipes: SessionPipes,
) -> anyhow::Result<()> {
    let result = run_session_connected(config, connection, id, cols, rows, &mut pipes).await;
    // connect 调用方还在等待时（建立失败或 shell 就绪前被取消），把原因转告。
    if let Some(ready_tx) = pipes.ready_tx.take() {
        let message = match &result {
            // shell 就绪后 ready_tx 已消费，仍持有说明是被主动取消。
            Ok(_) => "会话已取消".to_string(),
            Err(error) => format!("{error:#}"),
        };
        let _ = ready_tx.send(Err(message));
    }
    result
}

/// 连接、认证、开 shell、等接入、泵数据。返回 Ok 时的消息描述结束原因。
async fn run_session_connected(
    config: &Arc<client::Config>,
    connection: &ConnectionConfig,
    id: &str,
    cols: u32,
    rows: u32,
    pipes: &mut SessionPipes,
) -> anyhow::Result<()> {
    // 建立连接，期间随时可能被注册表关闭。
    let handle = tokio::select! {
        result = tokio::time::timeout(CONNECT_TIMEOUT, connect_and_auth(config, connection)) => {
            result.context_("连接超时")??
        }
        _ = &mut pipes.close_rx => return Ok(()),
    };

    // 开 PTY 并启动持久化入口命令：
    //   有 tmux → attach 到固定会话 ssh-main（断开后保活，重连恢复屏幕）；
    //   无 tmux → 回退普通 shell，并在终端里打一行提示。
    // 整条逻辑在远端一行命令内完成，服务端不做输出解析。
    let channel = handle.channel_open_session().await?;
    channel
        .request_pty(
            false,
            "xterm-256color",
            cols.min(MAX_COLS),
            rows.min(MAX_ROWS),
            0,
            0,
            &[],
        )
        .await?;
    channel.exec(false, START_COMMAND).await?;
    run_attached(handle, channel, connection, id, pipes).await
}

/// 远端启动命令：tmux 可用则 attach 固定会话，否则回退普通 shell。
/// 注意保持 POSIX sh 兼容（远端不一定是 bash）。
const START_COMMAND: &str = r"command -v tmux >/dev/null 2>&1 && tmux new -A -s ssh-main || { printf '\033[33m[ssh-web] 远端无 tmux，已回退普通 shell，断开后会话不保留\033[0m\n'; exec $SHELL; }";

/// 通道就绪后：通知 connect 成功、等 WS 接入、驱动数据泵、收尾。
async fn run_attached(
    handle: client::Handle<ClientHandler>,
    channel: russh::Channel<client::Msg>,
    connection: &ConnectionConfig,
    id: &str,
    pipes: &mut SessionPipes,
) -> anyhow::Result<()> {
    // 启动就绪，通知 connect 调用方成功。
    if let Some(ready_tx) = pipes.ready_tx.take() {
        let _ = ready_tx.send(Ok(()));
    }
    let (mut read_half, write_half) = channel.split();

    // 等 WS 接入，期间可能被主动关闭。
    let attach = tokio::select! {
        attach = &mut pipes.attach_rx => attach.context_("WS 接入前会话被关闭")?,
        _ = &mut pipes.close_rx => return Ok(()),
    };
    let Attach {
        mut input_rx,
        event_tx,
    } = attach;

    println!("会话 {id} 已接入 {}", connection.name);
    let result = pump(
        &mut read_half,
        &write_half,
        &mut input_rx,
        &event_tx,
        &mut pipes.close_rx,
    )
    .await;
    // 事件通道随 WS 泵任务一起结束；断开 SSH。
    let _ = handle
        .disconnect(Disconnect::ByApplication, "session closed", "en")
        .await;
    match result {
        Ok(message) => {
            println!("会话 {id} 结束：{message}");
            let _ = event_tx.send(WsEvent::Closed { message }).await;
        }
        Err(error) => {
            let _ = event_tx
                .send(WsEvent::Error {
                    message: format!("{error:#}"),
                })
                .await;
            return Err(error);
        }
    }
    Ok(())
}

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

/// 数据泵：WS 与 SSH 之间的双向转发。
///
/// - SSH → WS：`ChannelMsg::Data`/`ExtendedData` 原样转 binary 帧，
///   不做 String 转换，避免 UTF-8 跨 chunk 截断。
/// - WS → SSH：input 文本直接 `data_bytes` 写入；resize 调 `window_change`。
/// - 三路任一退出即整体退出：WS 关闭、SSH 关闭或注册表关闭。
async fn pump(
    read_half: &mut ChannelReadHalf,
    write_half: &ChannelWriteHalf<client::Msg>,
    input_rx: &mut mpsc::Receiver<ControlMessage>,
    event_tx: &mpsc::Sender<WsEvent>,
    close_rx: &mut oneshot::Receiver<()>,
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
            _ = &mut *close_rx => {
                return Ok("会话已手动关闭".into());
            }
        }
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

/// WS 消息长度上限的公开常量，供 WS 接入检查使用。
pub const WS_TEXT_LIMIT_BYTES: usize = WS_TEXT_LIMIT;
