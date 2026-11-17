#![cfg(all(unix, feature = "driver-fake"))]

use std::{net::SocketAddr, path::Path, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::TcpStream,
    process::{Child, Command},
    time::{Instant, timeout},
};

const KEY: &str = "process-shutdown-test-key";

async fn launch(db: &Path) -> (Child, SocketAddr) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_ursi-gateway"))
        .env("URSI_GATEWAY_KEY", KEY)
        .env("URSI_GATEWAY_DRIVER", "fake")
        .env("URSI_GATEWAY_NAMESPACE", "shutdown-test")
        .env("URSI_GATEWAY_TUNNEL", "false")
        .env("URSI_GATEWAY_BIND", "0.0.0.0:0")
        .env("URSI_GATEWAY_DB", db)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new();
    timeout(Duration::from_secs(5), output.read_line(&mut line))
        .await
        .expect("Gateway must announce its listener")
        .unwrap();
    let bound: SocketAddr = line
        .trim()
        .strip_prefix("ursi-gateway listening on ")
        .expect("Gateway must start successfully")
        .parse()
        .unwrap();
    assert!(bound.ip().is_unspecified());
    let address = SocketAddr::from(([127, 0, 0, 1], bound.port()));
    let response = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(3))
        .build()
        .unwrap()
        .get(format!("http://{address}/healthz"))
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());
    (child, address)
}

async fn terminate(child: &mut Child) {
    let started = Instant::now();
    let status = Command::new("kill")
        .arg("-TERM")
        .arg(child.id().unwrap().to_string())
        .status()
        .await
        .unwrap();
    assert!(status.success());
    let status = timeout(Duration::from_secs(5), child.wait())
        .await
        .expect("SIGTERM must finish despite an incomplete request body")
        .unwrap();
    assert!(status.success(), "normal shutdown failed: {status}");
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[tokio::test]
async fn sigterm_bounds_incomplete_authenticated_body_and_releases_database() {
    let directory = tempfile::tempdir().unwrap();
    let db = directory.path().join("gateway.sqlite");
    let (mut child, address) = launch(&db).await;
    let mut stalled = TcpStream::connect(address).await.unwrap();
    stalled.write_all(format!(
        "POST /api/v1/sandboxes HTTP/1.1\r\nHost: {address}\r\nAuthorization: Bearer {KEY}\r\nContent-Type: application/json\r\nContent-Length: 1000\r\nExpect: 100-continue\r\n\r\n"
    ).as_bytes()).await.unwrap();
    // 100 Continue 证明鉴权已通过且 JSON extractor 已开始等待请求体。
    let mut interim = [0; 25];
    timeout(Duration::from_secs(2), stalled.read_exact(&mut interim))
        .await
        .expect("authenticated request must reach body extraction")
        .unwrap();
    assert_eq!(&interim, b"HTTP/1.1 100 Continue\r\n\r\n");
    stalled.write_all(b"{\"image\":").await.unwrap();
    terminate(&mut child).await;
    // 故意保持客户端连接，排除客户端主动断开帮助服务器退出的假阳性。
    let (mut restarted, _) = launch(&db).await;
    terminate(&mut restarted).await;
    drop(stalled);
}

#[tokio::test]
async fn metadata_failure_exits_nonzero_and_releases_database() {
    let directory = tempfile::tempdir().unwrap();
    let db = directory.path().join("gateway.sqlite");
    let (mut child, address) = launch(&db).await;
    let connection = rusqlite::Connection::open(&db).unwrap();
    connection
        .execute(
            "INSERT INTO sandboxes (id, revision, body) VALUES ('corrupt', 0, 'invalid json')",
            [],
        )
        .unwrap();
    let status = timeout(Duration::from_secs(5), child.wait())
        .await
        .expect("worker failure must terminate the HTTP process")
        .unwrap();
    assert!(!status.success());
    assert!(TcpStream::connect(address).await.is_err());
    connection
        .execute("DELETE FROM sandboxes WHERE id = 'corrupt'", [])
        .unwrap();
    drop(connection);
    let (mut restarted, _) = launch(&db).await;
    terminate(&mut restarted).await;
}
