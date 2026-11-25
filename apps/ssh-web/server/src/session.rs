use std::process::Stdio;

use anyhow::{anyhow, Context, Result};
use bytes::Bytes;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tokio::process::Command;
use tokio::select;
use tokio::sync::mpsc;

use crate::models::Connection as ConnectionConfig;
use crate::models::TmuxSession;

/// 连接超时：不可达时 ssh 自身也会退出，这里兜底防悬挂。
pub const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
/// ssh 输出转发通道容量。
pub const EVENT_CAPACITY: usize = 32;
/// WS 输入通道容量。
pub const INPUT_CAPACITY: usize = 32;
/// 单条 WS 输入消息的 JSON 字节上限，超出视为异常客户端。
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

/// 泵任务发给 WS 任务的事件。Data 走 binary 帧，其余转 JSON 文本帧。
#[derive(Debug)]
pub enum WsEvent {
    /// 终端输出字节流，原样下发。
    Data(Bytes),
    /// 会话建立或运行失败，message 面向用户展示。
    Error { message: String },
    /// ssh 子进程退出，前端据此把终端标记为已结束。
    Closed { message: String },
}

/// WS 发来的控制消息。
#[derive(Debug)]
pub enum ControlMessage {
    Input(String),
    Resize { cols: u32, rows: u32 },
}

/// 从用户命令提取 ssh 参数（去掉首词 `ssh`），并追加服务端固定参数：
/// `-tt` 强制分配远端 PTY、`StrictHostKeyChecking=accept-new` 首连自动接受主机密钥。
/// 不加 `-q`：连接失败等诊断信息必须原样透传到终端。
/// 用户命令的其余参数原样保留（host、-p、-i、-J、config 别名等）。
fn ssh_args(command: &str, remote_script: &str) -> Vec<String> {
    let mut args: Vec<String> = command
        .split_whitespace()
        .skip(1)
        .map(String::from)
        .collect();
    args.push("-tt".into());
    args.push("-o".into());
    args.push("StrictHostKeyChecking=accept-new".into());
    args.push(remote_script.into());
    args
}

/// 终端任务：在本地 PTY 中启动 ssh 子进程、泵数据。
/// 建立或运行失败经 event_tx 发 Error；子进程退出发 Closed。
/// 随调用方（WS 循环）取消而结束，PTY 与子进程随之释放。
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
) -> Result<()> {
    let name = tmux_session.unwrap_or_else(|| DEFAULT_TMUX_SESSION.to_string());
    // 远端启动命令：tmux 可用则 attach 指定会话，否则回退普通 shell 并提示。
    // 会话名已过白名单，单引号内拼接安全。POSIX sh 兼容。
    let remote_script = format!(
        r"command -v tmux >/dev/null 2>&1 && tmux new -A -s '{name}' || {{ printf '\033[33m[ssh-web] 远端无 tmux，已回退普通 shell，断开后会话不保留\033[0m\n'; exec $SHELL; }}",
    );
    let args = ssh_args(&connection.command, &remote_script);

    // portable-pty：分配本地 PTY（初始尺寸即终端面板尺寸）并在其中启动 ssh。
    // ssh -tt 要求 stdin 是终端，PTY 由这里提供。
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.min(MAX_ROWS) as u16,
            cols: cols.min(MAX_COLS) as u16,
            pixel_width: 0,
            pixel_height: 0,
        })
        .context("分配 PTY 失败")?;

    let mut cmd = CommandBuilder::new("ssh");
    cmd.args(&args);
    // 远端 shell 与 tmux 依赖正确的终端类型；服务进程常无 TERM（nohup/守护），显式指定。
    cmd.env("TERM", "xterm-256color");
    let mut child = pair
        .slave
        .spawn_command(cmd)
        .context("启动 ssh 子进程失败：需要本机安装 ssh")?;
    drop(pair.slave); // 主端持有即可，从端关闭避免占用。

    // portable-pty 返回阻塞式 std IO，读端交给阻塞线程桥接为通道。
    // master 需要 resize，包进 Mutex 以满足跨 await 的 Send 约束；resize 不跨 await 持锁。
    let reader = pair.master.try_clone_reader().context("克隆 PTY 读端失败")?;
    let mut writer = pair.master.take_writer().context("取 PTY 写端失败")?;
    let master = std::sync::Arc::new(std::sync::Mutex::new(pair.master));

    let (out_tx, mut out_rx) = mpsc::channel::<Vec<u8>>(32);
    // 阻塞读线程：PTY 输出 → tokio 通道；WS 关闭时 out_tx 发送失败，线程退出。
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 64 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if out_tx.blocking_send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });

    let result = pump(&mut child, &mut writer, &master, &mut out_rx, input_rx, event_tx).await;
    // WS 断开时杀掉 ssh 子进程；远端 tmux 会话不受影响。
    let _ = child.kill();
    let _ = child.wait();
    match result {
        Ok(message) => {
            let _ = event_tx.send(WsEvent::Closed { message }).await;
            Ok(())
        }
        Err(error) => Err(error),
    }
}

/// 数据泵：本地 PTY 与 WS 之间的双向转发。
/// 输出经读线程桥接的 tokio 通道，与 WS 输入在 select 中对等竞争。
async fn pump(
    child: &mut Box<dyn portable_pty::Child + Send + Sync>,
    writer: &mut Box<dyn std::io::Write + Send>,
    master: &std::sync::Arc<std::sync::Mutex<Box<dyn portable_pty::MasterPty + Send>>>,
    out_rx: &mut mpsc::Receiver<Vec<u8>>,
    input_rx: &mut mpsc::Receiver<ControlMessage>,
    event_tx: &mpsc::Sender<WsEvent>,
) -> Result<String> {
    loop {
        select! {
            data = out_rx.recv() => {
                match data {
                    Some(bytes) => {
                        event_tx
                            .send(WsEvent::Data(Bytes::from(bytes)))
                            .await
                            .map_err(|_| anyhow!("WS 已关闭"))?;
                    }
                    // PTY EOF：子进程必然已退出（读端读到 EIO）。等一下再收尾，避免丢尾部输出。
                    None => {
                        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                        if child.try_wait()?.is_some() {
                            while let Ok(data) = out_rx.try_recv() {
                                event_tx
                                    .send(WsEvent::Data(Bytes::from(data)))
                                    .await
                                    .map_err(|_| anyhow!("WS 已关闭"))?;
                            }
                            let status = child.wait();
                            let code = status.ok().map(|s| s.exit_code()).unwrap_or(1u32);
                            return Ok(format!("ssh 已退出，exit code {code}"));
                        }
                    }
                }
            }
            control = input_rx.recv() => {
                match control {
                    Some(ControlMessage::Input(data)) => {
                        writer
                            .write_all(data.into_bytes().as_slice())
                            .context("PTY 写入失败")?;
                        writer.flush().context("PTY flush 失败")?;
                    }
                    Some(ControlMessage::Resize { cols, rows }) => {
                        let _ = master
                            .lock()
                            .map(|m| {
                                m.resize(PtySize {
                                    rows: rows.min(MAX_ROWS) as u16,
                                    cols: cols.min(MAX_COLS) as u16,
                                    pixel_width: 0,
                                    pixel_height: 0,
                                })
                            });
                    }
                    None => return Ok("WS 输入通道已关闭".into()),
                }
            }
        }
    }
}

/// 在远端执行一条命令，收集 stdout 与退出码。
async fn exec_collect(connection: &ConnectionConfig, remote_script: &str) -> Result<(String, i32)> {
    let args = ssh_args(&connection.command, remote_script);
    let output = tokio::time::timeout(
        CONNECT_TIMEOUT,
        // tmux ls 无交互输出，不需要 PTY，直接 ssh 批量执行。
        Command::new("ssh")
            .args(&args[..args.len() - 1]) // 去掉 -tt 保持批量模式干净
            .arg(remote_script)
            .stdin(Stdio::null())
            .stderr(Stdio::piped())
            .output(),
    )
    .await
    .map_err(|_| anyhow!("连接超时"))?
    .context("启动 ssh 子进程失败")?;
    let code = output.status.code().unwrap_or(-1);
    Ok((String::from_utf8_lossy(&output.stdout).into_owned(), code))
}

/// 列出远端 tmux 会话。远端没有 tmux 时返回 None（前端据此展示回退提示）。
/// tmux 无会话（exit 1）是正常空态。
pub async fn list_tmux_sessions(
    connection: &ConnectionConfig,
) -> Result<Option<Vec<TmuxSession>>> {
    // tmux 的 -F 格式串不解析 \t 转义（输出字面反斜杠），用竖线做字段分隔。
    // 竖线不在会话名白名单里，不会冲突。
    let (out, code) = exec_collect(
        connection,
        "tmux ls -F '#{session_name}|#{session_attached}|#{session_created}' 2>/dev/null",
    )
    .await?;
    match code {
        0 => {
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
        1 => Ok(Some(Vec::new())),
        // 127 = tmux 不存在。
        127 => Ok(None),
        code => Err(anyhow!("tmux ls 异常退出：{code}")),
    }
}
