//! HttpGatewayClient 契约验收测试：axum mock Gateway 全路径验证。
//!
//! 每个测试注释标注 Gateway 契约条目（ursi-sandbox/gateway/CONTRACT.md）：
//! - 身份与响应：Bearer 鉴权（401）、错误体形状、状态码语义；
//! - 控制面路由：POST/GET/DELETE /api/v1/sandboxes、幂等键绑定；
//! - Sandbox 与操作意图：生命周期请求先受理（202）、异步调度。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};

use super::HttpGatewayClient;
use crate::sandboxes::error::GatewayError;
use crate::sandboxes::model::{GatewaySandboxStatus, PortSpec, SandboxSpec};
use crate::sandboxes::traits::gateway::GatewayClient;

/// mock Gateway 状态：沙箱表、幂等键绑定与故障注入。
struct MockState {
    token: String,
    /// id -> (spec_json, status, endpoints)。
    sandboxes: Mutex<HashMap<String, (String, String, Vec<Value>)>>,
    /// 幂等键 -> 沙箱标识（契约：同一创建幂等键绑定同一规格与沙箱，
    /// 删除后保留 key 绑定）。
    idempotency: Mutex<HashMap<String, String>>,
    /// 幂等键 -> 规格文本（键复用时校验规格一致，不一致 409）。
    key_specs: Mutex<HashMap<String, String>>,
    counter: AtomicU64,
    /// 注入：每个请求先睡这段时间（构造客户端超时 → Unknown）。
    delay_ms: Mutex<u64>,
    /// 受理后异步变 running 的延迟（模拟后台调度）。
    promote_after_ms: u64,
    /// 注入：get 指定 id 返回 500。
    fail_500_ids: Mutex<Vec<String>>,
    /// 捕获的创建请求（验证头与 body）。
    captured_creates: Mutex<Vec<Value>>,
}

impl MockState {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            token: "mock-gateway-token-0123456789abcdef".into(),
            sandboxes: Mutex::new(HashMap::new()),
            idempotency: Mutex::new(HashMap::new()),
            key_specs: Mutex::new(HashMap::new()),
            counter: AtomicU64::new(0),
            delay_ms: Mutex::new(0),
            promote_after_ms: 300,
            fail_500_ids: Mutex::new(Vec::new()),
            captured_creates: Mutex::new(Vec::new()),
        })
    }

    fn error(status: StatusCode, code: &str, message: &str) -> axum::response::Response {
        (status, Json(json!({"error": {"code": code, "message": message}}))).into_response()
    }

    fn check_auth(&self, headers: &HeaderMap) -> Result<(), axum::response::Response> {
        let ok = headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            == Some(&format!("Bearer {}", self.token));
        if ok {
            Ok(())
        } else {
            // 契约「身份与响应」：缺失/错误身份返回 401。
            Err(Self::error(StatusCode::UNAUTHORIZED, "unauthorized", "身份无效"))
        }
    }

    async fn maybe_delay(&self) {
        let delay = *self.delay_ms.lock().unwrap();
        if delay > 0 {
            tokio::time::sleep(Duration::from_millis(delay)).await;
        }
    }

    fn sandbox_json(&self, id: &str) -> Option<Value> {
        let map = self.sandboxes.lock().unwrap();
        map.get(id).map(|(spec, status, endpoints)| {
            json!({
                "id": id,
                "spec": serde_json::from_str::<Value>(spec).unwrap_or(Value::Null),
                "status": status,
                "endpoints": endpoints,
            })
        })
    }
}

/// 契约「控制面路由」mock：POST/GET/DELETE /api/v1/sandboxes。
async fn create(
    State(state): State<Arc<MockState>>,
    headers: HeaderMap,
    body: String,
) -> axum::response::Response {
    if let Err(resp) = state.check_auth(&headers) {
        return resp;
    }
    state.maybe_delay().await;
    let spec: Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(_) => {
            // 契约：参数非法 400。
            return MockState::error(StatusCode::BAD_REQUEST, "invalid", "规格 JSON 非法");
        }
    };
    // 契约 SandboxSpec：image 必填。
    if spec.get("image").and_then(|i| i.as_str()).unwrap_or("").is_empty() {
        return MockState::error(StatusCode::BAD_REQUEST, "invalid", "image 必填");
    }
    let key = headers
        .get("Idempotency-Key")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    state
        .captured_creates
        .lock()
        .unwrap()
        .push(json!({"key": key, "body": spec}));

    // 契约：同一创建幂等键绑定同一规格与沙箱；键绑定其他规格 409。
    if !key.is_empty() {
        if let Some(existing_id) = state.idempotency.lock().unwrap().get(&key).cloned() {
            let same_spec = state.key_specs.lock().unwrap().get(&key).cloned() == Some(body.clone());
            if !same_spec {
                return MockState::error(
                    StatusCode::CONFLICT,
                    "conflict",
                    "幂等键已绑定其他规格",
                );
            }
            if let Some(v) = state.sandbox_json(&existing_id) {
                return (StatusCode::ACCEPTED, Json(v)).into_response();
            }
            // 键绑定保留（删除后）：按契约保留绑定，资源已删除时返回 404。
            return MockState::error(StatusCode::NOT_FOUND, "not_found", "沙箱已删除");
        }
    }

    let id = format!("sbx-{}", state.counter.fetch_add(1, Ordering::SeqCst) + 1);
    state.sandboxes.lock().unwrap().insert(
        id.clone(),
        (body.clone(), "preparing".into(), Vec::new()),
    );
    if !key.is_empty() {
        state.idempotency.lock().unwrap().insert(key.clone(), id.clone());
        state.key_specs.lock().unwrap().insert(key, body);
    }
    // 契约「Sandbox 与操作意图」：生命周期请求先落库再返回受理，
    // 驱动操作由后台调度——受理后异步变 running。
    let promote_state = state.clone();
    let promote_id = id.clone();
    let promote_after = state.promote_after_ms;
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(promote_after)).await;
        if let Some((_, status, endpoints)) = promote_state.sandboxes.lock().unwrap().get_mut(&promote_id) {
            *status = "running".into();
            *endpoints = vec![json!({
                "name": "web",
                "port": 8080,
                "visibility": "public",
                "address": format!("127.0.0.1:{}80", promote_id.len() + 20),
            })];
        }
    });
    let v = state.sandbox_json(&id).expect("刚创建的沙箱存在");
    (StatusCode::ACCEPTED, Json(v)).into_response()
}

async fn get_sandbox(
    State(state): State<Arc<MockState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> axum::response::Response {
    if let Err(resp) = state.check_auth(&headers) {
        return resp;
    }
    state.maybe_delay().await;
    if state.fail_500_ids.lock().unwrap().iter().any(|x| x == &id) {
        // 契约：内部存储错误 500，错误体安全摘要。
        return MockState::error(StatusCode::INTERNAL_SERVER_ERROR, "internal", "模拟内部错误");
    }
    match state.sandbox_json(&id) {
        Some(v) => (StatusCode::OK, Json(v)).into_response(),
        // 契约：资源不存在 404。
        None => MockState::error(StatusCode::NOT_FOUND, "not_found", "沙箱不存在"),
    }
}

async fn delete_sandbox(
    State(state): State<Arc<MockState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> axum::response::Response {
    if let Err(resp) = state.check_auth(&headers) {
        return resp;
    }
    state.maybe_delay().await;
    let existing = {
        let mut map = state.sandboxes.lock().unwrap();
        map.remove(&id)
    };
    let Some((spec, _status, _endpoints)) = existing else {
        // 契约：删除已完成再请求 → 资源不存在 404。
        return MockState::error(StatusCode::NOT_FOUND, "not_found", "沙箱不存在");
    };
    // 契约：删除期间先保留意图（202 带删除意图），完成后查询 404。
    state
        .sandboxes
        .lock()
        .unwrap()
        .insert(id.clone(), (spec, "deleting".into(), Vec::new()));
    let v = state.sandbox_json(&id).expect("删除中的沙箱存在");
    let delete_state = state.clone();
    let delete_id = id.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(120)).await;
        delete_state.sandboxes.lock().unwrap().remove(&delete_id);
        // 契约：删除后保留幂等 key 绑定（idempotency 表不动）。
    });
    (StatusCode::ACCEPTED, Json(v)).into_response()
}

fn mock_router(state: Arc<MockState>) -> Router {
    Router::new()
        .route("/api/v1/sandboxes", post(create))
        .route(
            "/api/v1/sandboxes/{id}",
            get(get_sandbox).delete(delete_sandbox),
        )
        .with_state(state)
}

async fn spawn_mock() -> (String, Arc<MockState>) {
    let state = MockState::new();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("绑定 mock 端口");
    let addr = listener.local_addr().expect("读取 mock 端口");
    let server_state = state.clone();
    tokio::spawn(async move {
        axum::serve(listener, mock_router(server_state.clone()))
            .await
            .expect("mock server 运行");
    });
    (format!("http://{addr}"), state)
}

fn client(base_url: &str, token: &str, timeout: Duration) -> HttpGatewayClient {
    HttpGatewayClient::new(base_url, token, timeout)
}

fn spec(image: &str) -> SandboxSpec {
    SandboxSpec {
        image: image.to_string(),
        ports: vec![PortSpec { name: "web".into(), port: 8080, ready: true }],
        memory_mb: Some(256),
        cpus: Some(1.0),
    }
}

// ---------------------------------------------------------------------------
// 契约：POST /api/v1/sandboxes（202 受理、幂等键、错误映射）
// ---------------------------------------------------------------------------

/// 契约「控制面路由」：POST 202 受理，sandbox_id 从响应回填；
/// 「Sandbox 与操作意图」：受理后异步变 running，get 反映生命周期状态。
#[tokio::test]
async fn prepare_202受理且受理后异步变running() {
    let (base, state) = spawn_mock().await;
    let c = client(&base, &state.token, Duration::from_secs(5));
    let receipt = c.prepare("op-1", &spec("img:1")).await.expect("受理成功");
    // 202 受理：sandbox_id 回填，状态 preparing → Accepted。
    let id = receipt.sandbox_id.expect("受理回执含沙箱标识");
    assert_eq!(receipt.status, crate::sandboxes::model::PrepareStatus::Accepted);
    assert_eq!(receipt.operation_id, "op-1");

    // 受理即查：preparing。
    let view = c.get(&id).await.expect("查询成功");
    assert_eq!(view.status, GatewaySandboxStatus::Preparing);

    // 后台调度完成：running 且端点快照返回。
    tokio::time::sleep(Duration::from_millis(state.promote_after_ms + 100)).await;
    let view = c.get(&id).await.expect("查询成功");
    assert_eq!(view.status, GatewaySandboxStatus::Running);
    assert_eq!(view.endpoints.len(), 1);
    assert_eq!(view.endpoints[0].name, "web");
    assert_eq!(view.endpoints[0].port, 8080);
}

/// 契约「控制面路由」：可选 Idempotency-Key；「同一创建幂等键绑定同一
/// 规格与沙箱」——重试携带相同键与规格返回同一沙箱，不额外分配资源；
/// 键绑定其他规格返回 409 → Conflict。
#[tokio::test]
async fn 幂等键复用同一沙箱且换规格冲突() {
    let (base, state) = spawn_mock().await;
    let c = client(&base, &state.token, Duration::from_secs(5));
    let first = c.prepare("op-1", &spec("img:1")).await.expect("受理成功");
    let second = c.prepare("op-1", &spec("img:1")).await.expect("受理成功");
    assert_eq!(first.sandbox_id, second.sandbox_id);
    // mock 只创建了一次。
    assert_eq!(state.counter.load(Ordering::SeqCst), 1);

    // 同键不同规格 → 409 Conflict。
    let err = c.prepare("op-1", &spec("img:other")).await.unwrap_err();
    assert!(matches!(err, GatewayError::Conflict(_)), "{err}");

    // 请求头契约：Authorization: Bearer 与 Idempotency-Key。
    let captured = state.captured_creates.lock().unwrap();
    assert!(captured.iter().all(|r| r["key"] == "op-1"));
    assert_eq!(captured[0]["body"]["image"], "img:1");
    assert_eq!(captured[0]["body"]["ports"][0]["name"], "web");
}

/// 契约「身份与响应」：缺失/错误身份返回 401 → Failed（不可当作可执行环境）。
#[tokio::test]
async fn 错误身份401映射为拒绝() {
    let (base, _state) = spawn_mock().await;
    let c = client(&base, "wrong-token-0123456789", Duration::from_secs(5));
    let err = c.prepare("op-1", &spec("img:1")).await.unwrap_err();
    assert!(matches!(err, GatewayError::Failed(_)), "{err}");
    assert!(err.to_string().contains("401"), "{err}");

    let err = c.get("sbx-1").await.unwrap_err();
    assert!(matches!(err, GatewayError::Failed(_)), "{err}");
}

/// 契约「身份与响应」：资源不存在 404 → get 映射 Failed；error.message
/// 进入错误文本（安全摘要）。
#[tokio::test]
async fn 查询不存在404映射为拒绝且消息透出() {
    let (base, state) = spawn_mock().await;
    let c = client(&base, &state.token, Duration::from_secs(5));
    let err = c.get("sbx-missing").await.unwrap_err();
    assert!(matches!(err, GatewayError::Failed(_)), "{err}");
    assert!(err.to_string().contains("沙箱不存在"), "{err}");
}

/// 契约「身份与响应」：内部存储错误 500 → Failed。
#[tokio::test]
async fn 内部错误500映射为拒绝() {
    let (base, state) = spawn_mock().await;
    state.fail_500_ids.lock().unwrap().push("sbx-boom".into());
    let c = client(&base, &state.token, Duration::from_secs(5));
    let err = c.get("sbx-boom").await.unwrap_err();
    assert!(matches!(err, GatewayError::Failed(_)), "{err}");
    // 错误体 message 透出（契约：不含驱动原始错误的安全摘要）。
    assert!(err.to_string().contains("模拟内部错误"), "{err}");
}

/// GatewayClient 语义：网络超时 → Unknown（结果未知，须查询核实）。
#[tokio::test]
async fn 请求超时映射为未知() {
    let (base, state) = spawn_mock().await;
    *state.delay_ms.lock().unwrap() = 1500;
    // 客户端超时 200ms < 服务端延迟 1500ms。
    let c = client(&base, &state.token, Duration::from_millis(200));
    let err = c.prepare("op-1", &spec("img:1")).await.unwrap_err();
    assert!(matches!(err, GatewayError::Unknown(_)), "{err}");
    let err = c.get("sbx-1").await.unwrap_err();
    assert!(matches!(err, GatewayError::Unknown(_)), "{err}");
}

// ---------------------------------------------------------------------------
// 契约：DELETE /api/v1/sandboxes/{id}（202 受理 → 404 终态、幂等释放）
// ---------------------------------------------------------------------------

/// 契约「控制面路由」：DELETE 202 带删除意图（confirmed=false），完成后
/// 查询 404；文档化语义：404 视为已删除 → confirmed=true（幂等释放）。
#[tokio::test]
async fn release_202未确认完成后404确认已删除() {
    let (base, state) = spawn_mock().await;
    let c = client(&base, &state.token, Duration::from_secs(5));
    let receipt = c.prepare("op-1", &spec("img:1")).await.expect("受理成功");
    let id = receipt.sandbox_id.expect("沙箱标识");

    // 202 受理：confirmed=false，本域保留 ReleasePending 查询核实。
    let r = c.release(&id).await.expect("释放受理成功");
    assert!(!r.confirmed, "202 受理不报告已释放");

    // 删除完成后查询 404。
    tokio::time::sleep(Duration::from_millis(300)).await;
    let err = c.get(&id).await.unwrap_err();
    assert!(matches!(err, GatewayError::Failed(_)), "{err}");

    // 幂等释放：已删除再请求 → 404 视为已删除，confirmed=true。
    let r = c.release(&id).await.expect("幂等释放成功");
    assert!(r.confirmed, "404 视为已删除（文档化语义）");
}

/// get 404 不受 release 的 404 特例影响：查询路径仍映射 Failed。
#[tokio::test]
async fn 查询的404仍映射为拒绝不受释放特例影响() {
    let (base, state) = spawn_mock().await;
    let c = client(&base, &state.token, Duration::from_secs(5));
    let err = c.get("sbx-never").await.unwrap_err();
    assert!(matches!(err, GatewayError::Failed(_)), "{err}");
}

// ---------------------------------------------------------------------------
// 客户端自身约束
// ---------------------------------------------------------------------------

/// Debug 输出脱敏：不泄露 Bearer token。
#[test]
fn debug输出不含token明文() {
    let c = client("http://127.0.0.1:1", "secret-token-0123456789abcdef", Duration::from_secs(1));
    let dbg = format!("{c:?}");
    assert!(!dbg.contains("secret-token"), "{dbg}");
    assert!(dbg.contains("***"), "{dbg}");
}

/// 请求规格序列化：SandboxSpec JSON 字段与契约一致（image/ports/
/// memory_mb/cpus），不含 run_id 等本域字段。
#[tokio::test]
async fn 请求body为契约规格字段() {
    let (base, state) = spawn_mock().await;
    let c = client(&base, &state.token, Duration::from_secs(5));
    c.prepare("op-1", &spec("img:1")).await.expect("受理成功");
    let captured = state.captured_creates.lock().unwrap();
    let body = &captured[0]["body"];
    assert_eq!(body["image"], "img:1");
    assert_eq!(body["memory_mb"], 256);
    assert!(body["ports"].is_array());
    assert!(body.get("run_id").is_none(), "规格不含本域关联字段");
}
