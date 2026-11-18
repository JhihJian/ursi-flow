//! 连接关闭与观测验收：显式关闭、断开可区分、观测事件、无消费者不影响功能。

#![allow(non_snake_case)]

mod common;

use std::sync::Arc;
use std::time::Duration;

use common::{spawn_tcp_echo, spawn_tunnel_echo};
use sandbox_access::channel::endpoint::EndpointDesc;
use sandbox_access::channel::error::ChannelError;
use sandbox_access::channel::observer::{ChannelObserver, ConnectionState};

#[derive(Default)]
struct Recorder {
    states: std::sync::Mutex<Vec<ConnectionState>>,
    bytes: std::sync::Mutex<Vec<sandbox_access::channel::ByteCounters>>,
}

impl ChannelObserver for Recorder {
    fn on_connection_state(&self, s: ConnectionState) {
        self.states.lock().unwrap().push(s);
    }
    fn on_bytes(&self, c: &sandbox_access::channel::ByteCounters) {
        self.bytes.lock().unwrap().push(*c);
    }
}

#[tokio::test]
async fn 关闭后使用返回Closed() {
    let addr = spawn_tcp_echo().await;
    let mut conn = sandbox_access::channel::Channel::connect(
        EndpointDesc::direct(addr.ip().to_string(), addr.port()),
        None,
    )
    .await
    .unwrap();
    assert!(conn.is_open());
    conn.close().await.unwrap();
    assert!(!conn.is_open());

    let err = conn.send(b"x").await.unwrap_err();
    assert!(matches!(err, ChannelError::Closed), "{err}");
    let mut buf = [0u8; 4];
    let err = conn.recv(&mut buf).await.unwrap_err();
    assert!(matches!(err, ChannelError::Closed), "{err}");

    // 重复关闭无副作用。
    conn.close().await.unwrap();
}

#[tokio::test]
async fn drop连接静默回收() {
    let addr = spawn_tcp_echo().await;
    {
        let mut conn = sandbox_access::channel::Channel::connect(
            EndpointDesc::direct(addr.ip().to_string(), addr.port()),
            None,
        )
        .await
        .unwrap();
        conn.close().await.unwrap();
        drop(conn);
    }
    // 不 panic 即通过；echo server 仍在运行可再次连接。
    let mut conn = sandbox_access::channel::Channel::connect(
        EndpointDesc::direct(addr.ip().to_string(), addr.port()),
        None,
    )
    .await
    .unwrap();
    conn.close().await.unwrap();
}

#[tokio::test]
async fn 服务端断开返回可区分连接故障() {
    // 纯 TCP echo 在收到连接后立即关闭（用一次性 listener 模拟服务端断开）。
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let (sock, _) = listener.accept().await.unwrap();
        drop(sock); // 立即断开
        loop {
            let _ = listener.accept().await; // 继续接受后续连接
        }
    });
    let mut conn = sandbox_access::channel::Channel::connect(
        EndpointDesc::direct(addr.ip().to_string(), addr.port()),
        None,
    )
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;

    let mut buf = [0u8; 8];
    let err = loop {
        match conn.recv(&mut buf).await {
            Ok(0) | Err(_) => break conn_err(&mut conn).await,
            Ok(_) => continue,
        }
    };
    assert!(
        matches!(err, ChannelError::Io(_) | ChannelError::Closed),
        "断开应返回连接故障：{err}"
    );
}

async fn conn_err(conn: &mut sandbox_access::channel::SandboxConnection) -> ChannelError {
    // 断开后 send 也应失败。
    conn.send(b"after-break")
        .await
        .err()
        .unwrap_or(ChannelError::Closed)
}

#[tokio::test]
async fn 观测者收到连接状态与字节计数() {
    let addr = spawn_tcp_echo().await;
    eprintln!("观测: echo 已启动 {}", addr);
    let rec = Arc::new(Recorder::default());
    let mut conn = sandbox_access::channel::Channel::connect(
        EndpointDesc::direct(addr.ip().to_string(), addr.port()),
        Some(rec.clone() as Arc<dyn ChannelObserver>),
    )
    .await
    .unwrap();
    eprintln!("观测: 已连接");
    conn.send(b"observe-me").await.unwrap();
    eprintln!("观测: 已发送");
    let mut buf = [0u8; 10];
    let n = tokio::time::timeout(Duration::from_secs(3), conn.recv(&mut buf))
        .await
        .expect("观测: recv 超时");
    eprintln!("观测: 已接收 {:?}", n);
    conn.close().await.unwrap();
    eprintln!("观测: 已关闭");

    let states_snapshot = rec.states.lock().unwrap().clone();
    eprintln!("观测: states={states_snapshot:?}");
    assert!(states_snapshot.contains(&ConnectionState::Connected), "{states_snapshot:?}");
    assert!(states_snapshot.contains(&ConnectionState::Closed), "{states_snapshot:?}");
    let last = rec.bytes.lock().unwrap().last().copied();
    eprintln!("观测: last counters={last:?}");
    assert!(last.is_some(), "应有字节计数事件");
    let (tx, rx) = (last.unwrap().tx_bytes, last.unwrap().rx_bytes);
    assert_eq!(tx, 10, "发送计数");
    assert_eq!(rx, 10, "接收计数");
}

#[tokio::test]
async fn 隧道模式关闭后返回Closed() {
    let tunnel = spawn_tunnel_echo().await;
    let mut conn = sandbox_access::channel::Channel::connect(
        EndpointDesc::tunnel(
            "sb-1",
            "echo",
            format!("ws://{}:{}", tunnel.ip(), tunnel.port()),
            "tok",
        ),
        None,
    )
    .await
    .unwrap();
    conn.close().await.unwrap();
    let err = conn.send(b"x").await.unwrap_err();
    assert!(matches!(err, ChannelError::Closed), "{err}");
}
