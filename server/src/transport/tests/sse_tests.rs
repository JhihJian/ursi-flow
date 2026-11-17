//! SSE 事件流验收测试：订阅、历史与实时交界去重、游标续读、慢消费者
//! 补读与断开释放。
//!
//! 覆盖 SPEC transport「事件流与重放」全部验收条目。

use std::net::SocketAddr;
use std::time::Duration;

use reqwest::Client;

use crate::transport::static_assets::StaticAssets;
use crate::transport::stubs::test_app_state;
use crate::transport::serve;

/// SSE 帧解析：从响应字节流提取 data JSON 的 seq 序列。
async fn collect_seqs(
    response: reqwest::Response,
    max_frames: usize,
    timeout: Duration,
) -> Vec<u64> {
    let mut response = response;
    let mut seqs = Vec::new();
    let deadline = tokio::time::Instant::now() + timeout;
    let mut buffer = String::new();
    while seqs.len() < max_frames {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        match tokio::time::timeout(remaining, response.chunk()).await {
            Ok(Ok(Some(chunk))) => {
                buffer.push_str(&String::from_utf8_lossy(&chunk));
                // 解析完整的 data 行。
                while let Some(pos) = buffer.find("\n\n") {
                    let frame: String = buffer.drain(..pos + 2).collect();
                    for line in frame.lines() {
                        if let Some(data) = line.strip_prefix("data: ") {
                            let value: serde_json::Value = serde_json::from_str(data)
                                .unwrap_or(serde_json::Value::Null);
                            if let Some(seq) = value.get("seq").and_then(|s| s.as_u64()) {
                                seqs.push(seq);
                            }
                        }
                    }
                }
            }
            _ => break,
        }
    }
    seqs
}

/// 启动带事件源替身的测试服务。
async fn spawn_app() -> (
    String,
    std::sync::Arc<crate::transport::stubs::FakeEventFeed>,
) {
    let (state, _wf, _roles, _runs, _art, _sbx, _conn, events) =
        test_app_state(StaticAssets::disabled());
    // SSE 测试主运行：订阅/续读目标，事件由各测试自行追加。
    events.register_run("run-1");
    let addr = serve(state, SocketAddr::from(([127, 0, 0, 1], 0)))
        .await
        .expect("测试服务启动成功");
    (format!("http://{addr}"), events)
}

/// SPEC「事件流与重放」验收 1 + 2：
/// 订阅只输出该运行的事件；历史与实时交界插入的事件恰好收到一次（去重）。
#[tokio::test]
async fn subscription_filters_run_and_dedupes_boundary() {
    let (base, events) = spawn_app().await;
    let client = Client::new();

    // 预置另一个运行的历史事件（不应出现在订阅里）。
    events.publish("run-other", "other-1");

    // run-1 已有一条历史事件。
    let first = events.publish("run-1", "history-1");

    // 订阅建立后立刻推实时事件（交界处事件：先广播再写历史没法构造
    // 单一实现，这里用 publish 的原子性保证：订阅完成后 publish 即是
    // "交界处只出现一次" 的场景——通知与持久源各一次，SSE 按 seq 去重）。
    let response = client
        .get(format!("{base}/api/v1/runs/run-1/events"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(
        response.headers()["content-type"],
        "text/event-stream",
        "SSE content-type"
    );

    // 交界处事件：订阅建立后提交（替身同时写历史 + 广播）。
    let boundary = events.publish("run-1", "boundary-1");
    let _ = events.publish("run-other", "other-2");

    let seqs = collect_seqs(response, 2, Duration::from_secs(5)).await;
    assert_eq!(
        seqs,
        vec![first.seq, boundary.seq],
        "历史 + 交界事件各一次，且不混入其他运行"
    );
}

/// SPEC「事件流与重放」验收 3：
/// 慢消费者触发通知滞后后可从持久事件补读，不静默丢失。
#[tokio::test]
async fn slow_consumer_recovers_from_persistent_source() {
    let (base, events) = spawn_app().await;
    let client = Client::new();

    let response = client
        .get(format!("{base}/api/v1/runs/run-1/events"))
        .send()
        .await
        .unwrap();

    // 模拟通知滞后/丢帧：只写持久源不广播（提交成功、广播丢失）。
    let silent1 = events.publish_silently("run-1", "silent-1");
    let silent2 = events.publish_silently("run-1", "silent-2");
    // 再发一条正常通知触发 SSE 回源拉取。
    let live = events.publish("run-1", "live-1");

    let seqs = collect_seqs(response, 3, Duration::from_secs(5)).await;
    assert_eq!(
        seqs,
        vec![silent1.seq, silent2.seq, live.seq],
        "通知丢失的事件经持久源补读，不静默丢失"
    );
}

/// SPEC「事件流与重放」验收 4：
/// 携带有效游标重连时继续读取后续事件；无效游标返回明确错误。
#[tokio::test]
async fn cursor_reconnect_continues_and_invalid_cursor_is_400() {
    let (base, events) = spawn_app().await;
    let client = Client::new();

    let e1 = events.publish("run-1", "first");
    let e2 = events.publish("run-1", "second");

    // 无效游标：400 / invalid_cursor 明确错误，不建立流。
    for bad in ["abc", "-1", "1.5", ""] {
        let response = client
            .get(format!("{base}/api/v1/runs/run-1/events?after={bad}"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 400, "游标 {bad:?} 应返回 400");
        let body: serde_json::Value = response.json().await.unwrap();
        assert_eq!(body["error"]["code"], "invalid_cursor", "游标 {bad:?}");
    }

    // 有效游标续读：after=e1.seq 只输出后续事件。
    let response = client
        .get(format!(
            "{base}/api/v1/runs/run-1/events?after={}",
            e1.seq
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let seqs = collect_seqs(response, 1, Duration::from_secs(5)).await;
    assert_eq!(seqs, vec![e2.seq], "游标续读不重发已读事件");

    // run 不存在：订阅握手即失败（404）。
    let response = client
        .get(format!("{base}/api/v1/runs/no-such-run/events"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 404);
}

/// SPEC「事件流与重放」验收 5：
/// 客户端断开后订阅资源释放，运行继续执行。
#[tokio::test]
async fn disconnect_releases_subscription_and_run_continues() {
    let (base, events) = spawn_app().await;
    let client = Client::new();

    {
        // 订阅后立刻断开（drop response）。
        let response = client
            .get(format!("{base}/api/v1/runs/run-1/events"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(events.subscribe_count(), 1);
        // response drop：连接关闭。
    }

    // 运行继续执行：事件继续提交（publish 不受断开影响）。
    // 给发布侧一点时间感知断开；替身在下次 publish 时清理已关闭订阅。
    tokio::time::sleep(Duration::from_millis(100)).await;
    events.publish("run-1", "after-disconnect");
    // 断开的订阅在广播时被清理并计数。
    assert!(
        events.closed_count() >= 1,
        "客户端断开后订阅资源应释放（closed={}）",
        events.closed_count()
    );
    // 持久源继续累积（运行不受影响）。
    let history = crate::transport::EventFeed::read_since(events.as_ref(), "run-1", 0)
        .await
        .unwrap();
    assert_eq!(history.len(), 1);
}


