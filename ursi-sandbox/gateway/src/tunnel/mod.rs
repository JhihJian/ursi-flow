//! `ursi-tcp-v1`：二进制承载原始 TCP 字节，文本 `eof` 关闭 TCP 写方向。
//! 客户端消息上限 64 KiB，服务端输出块上限 32 KiB。EOF 后仍接收另一方向
//! 的数据，重复 EOF 或 EOF 后的数据会关闭整个连接。仅 lifecycle 可决定目标。

use std::{sync::Arc, time::Duration};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use futures_util::{SinkExt, StreamExt};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::{mpsc, watch},
    time::{self, Instant},
};

use crate::{
    lifecycle::Service,
    models::{Error, Resource, Status, valid_name},
};

pub const PROTOCOL: &str = "ursi-tcp-v1";
pub const MAX_CLIENT_MESSAGE: usize = 64 * 1024;
pub const OUTPUT_CHUNK: usize = 32 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const WRITE_TIMEOUT: Duration = Duration::from_secs(30);
const IDLE_TIMEOUT: Duration = Duration::from_secs(75);
const PING_INTERVAL: Duration = Duration::from_secs(20);
const CHECK_INTERVAL: Duration = Duration::from_millis(250);

/// 目标拨号失败与生命周期错误分开，前者由 HTTP 接入层映射为 502。
pub enum ConnectError {
    Service(Error),
    Unreachable,
}

pub struct Target {
    stream: TcpStream,
    resource: Resource,
}

/// 必须在通过 API 身份校验后调用。客户端只提供两个标识，不能传递地址。
pub async fn connect(service: &Service, id: &str, endpoint: &str) -> Result<Target, ConnectError> {
    if !valid_name(id) || !valid_name(endpoint) {
        return Err(ConnectError::Service(Error::Invalid(
            "invalid identifier".into(),
        )));
    }
    let before = service.get(id).map_err(ConnectError::Service)?;
    if before.status != Status::Running || before.operation.is_some() {
        return Err(ConnectError::Service(Error::Conflict(
            "sandbox is not available".into(),
        )));
    }
    let stream = time::timeout(CONNECT_TIMEOUT, async {
        let (_endpoint, address) = service
            .resolve_target(id, endpoint)
            .await
            .map_err(ConnectError::Service)?;
        TcpStream::connect(&address)
            .await
            .map_err(|_| ConnectError::Unreachable)
    })
    .await
    .map_err(|_| ConnectError::Unreachable)??;
    // 拨号期间发生停删或重建时，不升级旧资源上的连接。
    let current = service.get(id).map_err(ConnectError::Service)?;
    if current.status != Status::Running
        || current.operation.is_some()
        || current.resource != before.resource
    {
        return Err(ConnectError::Service(Error::Conflict(
            "sandbox changed".into(),
        )));
    }
    Ok(Target {
        stream,
        resource: current.resource,
    })
}

pub fn configure(upgrade: WebSocketUpgrade) -> WebSocketUpgrade {
    upgrade
        .protocols([PROTOCOL])
        .max_message_size(MAX_CLIENT_MESSAGE)
        .max_frame_size(MAX_CLIENT_MESSAGE)
        .write_buffer_size(0)
        .max_write_buffer_size(2 * MAX_CLIENT_MESSAGE)
}

pub async fn relay(socket: WebSocket, target: Target, service: Arc<Service>, id: String) {
    relay_with_check(socket, target.stream, move || {
        !service.is_stopping()
            && service.get(&id).is_ok_and(|sandbox| {
                sandbox.status == Status::Running
                    && sandbox.operation.is_none()
                    && sandbox.resource == target.resource
            })
    })
    .await;
}

#[derive(Clone, Copy)]
struct Progress {
    input_eof: bool,
    output_eof: bool,
    last_activity: Instant,
}

/// 两个方向直接等待各自下游写入。控制帧队列容量为 1，没有无界中间队列。
/// 监控 future 与中继并行，背压和写超时均不能阻挡生命周期取消。
async fn relay_with_check(socket: WebSocket, stream: TcpStream, alive: impl Fn() -> bool) {
    let (mut ws_write, mut ws_read) = socket.split();
    let (mut tcp_read, mut tcp_write) = stream.into_split();
    let (progress, mut changes) = watch::channel(Progress {
        input_eof: false,
        output_eof: false,
        last_activity: Instant::now(),
    });
    let (control_tx, mut control_rx) = mpsc::channel(1);
    {
        let input = async {
            let mut eof = false;
            while let Some(message) = ws_read.next().await {
                let message = message.map_err(|_| ())?;
                progress.send_modify(|state| state.last_activity = Instant::now());
                match message {
                    Message::Binary(bytes) if !eof && bytes.len() <= MAX_CLIENT_MESSAGE => {
                        time::timeout(WRITE_TIMEOUT, tcp_write.write_all(&bytes))
                            .await
                            .map_err(|_| ())?
                            .map_err(|_| ())?;
                    }
                    Message::Text(text) if !eof && text == "eof" => {
                        time::timeout(WRITE_TIMEOUT, tcp_write.shutdown())
                            .await
                            .map_err(|_| ())?
                            .map_err(|_| ())?;
                        eof = true;
                        progress.send_modify(|state| state.input_eof = true);
                    }
                    Message::Ping(payload) => control_tx
                        .send(Message::Pong(payload))
                        .await
                        .map_err(|_| ())?,
                    Message::Pong(_) => {}
                    _ => return Err(()),
                }
            }
            Err::<(), ()>(())
        };
        let output = async {
            let mut buffer = vec![0; OUTPUT_CHUNK];
            let mut eof = false;
            let mut ping = time::interval_at(Instant::now() + PING_INTERVAL, PING_INTERVAL);
            ping.set_missed_tick_behavior(time::MissedTickBehavior::Delay);
            loop {
                let message = tokio::select! {
                    count = tcp_read.read(&mut buffer), if !eof => {
                        let count = count.map_err(|_| ())?;
                        if count == 0 {
                            eof = true;
                            Message::Text("eof".into())
                        } else {
                            Message::Binary(buffer[..count].to_vec().into())
                        }
                    }
                    Some(control) = control_rx.recv() => control,
                    _ = ping.tick() => Message::Ping(Vec::new().into()),
                };
                let has_payload = matches!(message, Message::Binary(_) | Message::Text(_));
                time::timeout(WRITE_TIMEOUT, ws_write.send(message))
                    .await
                    .map_err(|_| ())?
                    .map_err(|_| ())?;
                if has_payload {
                    progress.send_modify(|state| state.last_activity = Instant::now());
                }
                if eof && !progress.borrow().output_eof {
                    progress.send_modify(|state| state.output_eof = true);
                }
            }
            #[allow(unreachable_code)]
            Ok::<(), ()>(())
        };
        let monitor = async {
            let mut check = time::interval(CHECK_INTERVAL);
            check.set_missed_tick_behavior(time::MissedTickBehavior::Delay);
            loop {
                tokio::select! {
                    _ = check.tick() => {
                        if !alive() || progress.borrow().last_activity.elapsed() >= IDLE_TIMEOUT {
                            return;
                        }
                    }
                    result = changes.changed() => {
                        if result.is_err() { return; }
                        let state = *changes.borrow_and_update();
                        if state.input_eof && state.output_eof { return; }
                    }
                }
            }
        };
        tokio::select! {
            _ = input => {}
            _ = output => {}
            _ = monitor => {}
        }
    }
    // 先回收 TCP，关闭握手最多占用 200 ms，慢客户端不能延迟资源释放。
    drop(tcp_read);
    drop(tcp_write);
    let _ = time::timeout(
        Duration::from_millis(200),
        ws_write.send(Message::Close(None)),
    )
    .await;
}

#[cfg(test)]
mod tests;
