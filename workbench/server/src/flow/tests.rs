use super::*;
use std::time::Duration;
use tokio::{io::AsyncWriteExt, net::UnixListener, time::timeout};
use ursi_flow_client::FlowClient as SdkClient;

#[tokio::test]
async fn cancelled_caller_keeps_slot_until_blocking_call_finishes() {
    let socket = std::env::temp_dir().join(Uuid::new_v4().to_string());
    let listener = UnixListener::bind(&socket).unwrap();
    let client = FlowClient::new(SdkClient::new(&socket));
    let service = FlowService::new(client.clone(), PathBuf::new());
    let mut pending = Vec::new();
    for _ in 0..8 {
        let copy = service.clone();
        let caller = tokio::spawn(async move { copy.flows().await });
        let (conn, _) = timeout(Duration::from_secs(5), listener.accept())
            .await
            .unwrap()
            .unwrap();
        pending.push((caller, conn));
    }
    let (caller, conn) = pending.pop().unwrap();
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());

    let other = FlowService::new(client, PathBuf::new());
    let next = tokio::spawn(async move { other.runs().await });
    assert!(
        timeout(Duration::from_millis(20), listener.accept())
            .await
            .is_err()
    );
    drop(conn);
    let (mut conn, _) = timeout(Duration::from_secs(5), listener.accept())
        .await
        .unwrap()
        .unwrap();
    conn.write_all(br#"{"v":1,"data":true}"#).await.unwrap();
    conn.shutdown().await.unwrap();
    assert_eq!(next.await.unwrap().unwrap(), true);
    drop(pending);
    std::fs::remove_file(socket).unwrap();
}

#[tokio::test]
async fn workspace_rejected_before_client_io() {
    let service = FlowService::new(FlowClient::new(SdkClient::new("unused")), PathBuf::new());
    for input in ["", "Default", ".", "..", "/tmp", "default/"] {
        let result = service
            .start("f".into(), None, input, serde_json::json!({}))
            .await;
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::InvalidInput);
    }
}
