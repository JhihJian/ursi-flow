//! Gateway 控制面 HTTP 客户端（`GatewayClient` 真实实现，reqwest）。
//!
//! 协议对齐 `ursi-sandbox/gateway/CONTRACT.md`：
//! - `prepare`：`POST /api/v1/sandboxes`，`Authorization: Bearer <key>` 与
//!   `Idempotency-Key: <operation_id>`，body 为 [`SandboxSpec`] JSON；
//!   202 受理返回 Sandbox（`sandbox_id` 从响应回填），其他状态码映射为
//!   [`GatewayError`]（400/401/404/501/503/500 → Failed，409 → Conflict，
//!   网络超时与断连 → Unknown，结果未知语义）。
//! - `get`：`GET /api/v1/sandboxes/{id}`，200 返回 [`GatewaySandboxView`]，
//!   status 按 preparing/running/stopped/deleting/error 映射，404 → Failed。
//! - `release`：`DELETE /api/v1/sandboxes/{id}`；202 视为删除意图已受理
//!   （confirmed=false，完成后查询 404，由本域经 get 核实）；
//!   **404 视为已删除，confirmed=true（文档化语义）**；
//!   其余状态码与网络故障按 prepare 同规则映射。
//!
//! 契约身份：Bearer key 由 Gateway 启动配置（≥16 字节）；客户端 Debug
//! 输出脱敏 token。错误体为 `{"error":{"code","message"}}`，诊断取
//! message（契约已约定不含驱动原始错误）。

use std::time::Duration;

use async_trait::async_trait;
use reqwest::StatusCode;
use serde::Deserialize;
use serde_json::Value;

use crate::sandboxes::error::GatewayError;
use crate::sandboxes::model::{
    EndpointView, GatewaySandboxStatus, GatewaySandboxView, PrepareReceipt, PrepareStatus,
    ReleaseReceipt, SandboxSpec,
};
use crate::sandboxes::traits::gateway::GatewayClient;

/// 契约错误体形状：`{"error":{"code":"...","message":"..."}}`。
#[derive(Debug, Deserialize)]
struct ErrorBody {
    #[serde(default)]
    error: Option<ErrorDetail>,
}

#[derive(Debug, Deserialize)]
struct ErrorDetail {
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    message: Option<String>,
}

/// Gateway 控制面 HTTP 客户端。
pub struct HttpGatewayClient {
    http: reqwest::Client,
    /// Gateway 控制面基地址（如 `http://127.0.0.1:8080`）。
    base_url: String,
    /// Bearer 凭据（Debug 输出脱敏）。
    token: String,
}

impl std::fmt::Debug for HttpGatewayClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HttpGatewayClient")
            .field("base_url", &self.base_url)
            // 脱敏：不输出 token 明文。
            .field("token", &"***")
            .finish()
    }
}

/// Gateway 响应 Sandbox 的客户端投影（只取平台视图需要的字段；
/// spec/resource/operation 等字段由 Gateway 拥有，本域不解释）。
#[derive(Debug, Deserialize)]
struct SandboxResponse {
    id: String,
    status: String,
    #[serde(default)]
    endpoints: Vec<EndpointResponse>,
}

#[derive(Debug, Deserialize)]
struct EndpointResponse {
    name: String,
    port: u16,
    address: String,
}

impl HttpGatewayClient {
    /// 构造客户端：`base_url` 为 Gateway 控制面基地址，`token` 为
    /// Bearer 凭据，`timeout` 为单请求超时（超时即结果未知）。
    pub fn new(base_url: impl Into<String>, token: impl Into<String>, timeout: Duration) -> Self {
        Self {
            http: reqwest::Client::builder()
                .timeout(timeout)
                .build()
                .expect("构造 Gateway HTTP 客户端"),
            base_url: base_url.into().trim_end_matches('/').to_string(),
            token: token.into(),
        }
    }

    fn sandbox_url(&self, sandbox_id: &str) -> String {
        format!("{}/api/v1/sandboxes/{sandbox_id}", self.base_url)
    }

    /// 把网络层失败映射为结果未知（超时、断连、请求构建失败）。
    fn map_network_error(e: reqwest::Error, op: &str) -> GatewayError {
        if e.is_timeout() {
            GatewayError::Unknown(format!("{op} 超时：{e}"))
        } else {
            GatewayError::Unknown(format!("{op} 请求失败（结果未知）：{e}"))
        }
    }

    fn headers(&self) -> reqwest::header::HeaderMap {
        use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION};
        let mut headers = HeaderMap::new();
        if let Ok(v) = HeaderValue::from_str(&format!("Bearer {}", self.token)) {
            headers.insert(AUTHORIZATION, v);
        }
        headers
    }

    /// 发送请求并分类响应：2xx 原样返回，其余按契约状态码映射。
    ///
    /// 请求构建/发送失败一律 Unknown（请求可能已到达 Gateway，结果未知）。
    /// 404 特殊处理：`on_404_deleted` 为 true 时返回 `Ok(已删除标记)`
    /// （release 的文档化语义），否则映射 Failed（get 的不存在语义）。
    async fn classify(
        &self,
        op: &str,
        method: reqwest::Method,
        url: String,
        idempotency_key: Option<&str>,
        body: Option<Value>,
        on_404_deleted: bool,
    ) -> Result<reqwest::Response, GatewayError> {
        let mut request = self.http.request(method, &url).headers(self.headers());
        if let Some(key) = idempotency_key {
            request = request.header("Idempotency-Key", key);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request
            .send()
            .await
            .map_err(|e| Self::map_network_error(e, op))?;
        let status = response.status();
        if status.is_success() {
            return Ok(response);
        }
        // 契约错误体：{"error":{"code","message"}}；解析失败给安全摘要。
        let message = response
            .text()
            .await
            .ok()
            .and_then(|text| serde_json::from_str::<ErrorBody>(&text).ok())
            .and_then(|body| body.error)
            .and_then(|detail| detail.message.or(detail.code))
            .unwrap_or_else(|| format!("HTTP {status}"));
        if status == StatusCode::NOT_FOUND && on_404_deleted {
            return Err(GatewayError::Deleted(message));
        }
        Err(match status {
            StatusCode::CONFLICT => GatewayError::Conflict(message),
            _ => GatewayError::Failed(format!(
                "{op} 被拒绝（HTTP {status}）：{message}"
            )),
        })
    }

    /// 解析 202 受理响应中的 Sandbox 投影。
    async fn parse_sandbox(
        &self,
        response: reqwest::Response,
        op: &str,
    ) -> Result<SandboxResponse, GatewayError> {
        response.json::<SandboxResponse>().await.map_err(|e| {
            GatewayError::Unknown(format!("{op} 响应解析失败（结果未知）：{e}"))
        })
    }
}

/// 契约 status 字符串映射为平台生命周期状态。
fn map_status(text: &str) -> Option<GatewaySandboxStatus> {
    match text {
        "preparing" => Some(GatewaySandboxStatus::Preparing),
        "running" => Some(GatewaySandboxStatus::Running),
        "stopped" => Some(GatewaySandboxStatus::Stopped),
        "deleting" => Some(GatewaySandboxStatus::Deleting),
        "error" => Some(GatewaySandboxStatus::Error),
        _ => None,
    }
}

#[async_trait]
impl GatewayClient for HttpGatewayClient {
    /// 契约「控制面路由」：POST /api/v1/sandboxes，202 返回 Sandbox。
    ///
    /// 幂等键 `Idempotency-Key: <operation_id>`；同一键绑定同一规格与
    /// 沙箱，重试不额外分配资源。202 响应含沙箱标识时回填；尚未分配
    /// （理论不发生，防御）时以 Accepted 空 ID 返回，由本域查询核实。
    async fn prepare(
        &self,
        operation_id: &str,
        spec: &SandboxSpec,
    ) -> Result<PrepareReceipt, GatewayError> {
        let body = serde_json::to_value(spec)
            .map_err(|e| GatewayError::Failed(format!("规格序列化失败：{e}")))?;
        let response = self
            .classify(
                "准备沙箱",
                reqwest::Method::POST,
                format!("{}/api/v1/sandboxes", self.base_url),
                Some(operation_id),
                Some(body),
                false,
            )
            .await?;
        if response.status() != StatusCode::ACCEPTED {
            // 契约只承诺 202 受理；其他 2xx 视为未知结果（防御）。
            return Err(GatewayError::Unknown(format!(
                "准备沙箱返回非受理状态（HTTP {}）：结果未知",
                response.status()
            )));
        }
        let sandbox = self.parse_sandbox(response, "准备沙箱").await?;
        let status = map_status(&sandbox.status);
        Ok(PrepareReceipt {
            operation_id: operation_id.to_string(),
            sandbox_id: Some(sandbox.id),
            status: match status {
                Some(GatewaySandboxStatus::Running) => PrepareStatus::Ready,
                Some(GatewaySandboxStatus::Error) => PrepareStatus::Failed,
                _ => PrepareStatus::Accepted,
            },
        })
    }

    /// 契约「控制面路由」：GET /api/v1/sandboxes/{id}，200 返回 Sandbox。
    /// 404 映射为 Failed（trait 语义：不存在由实现方映射）。
    async fn get(&self, sandbox_id: &str) -> Result<GatewaySandboxView, GatewayError> {
        let response = self
            .classify(
                "查询沙箱",
                reqwest::Method::GET,
                self.sandbox_url(sandbox_id),
                None,
                None,
                false,
            )
            .await?;
        let sandbox = self.parse_sandbox(response, "查询沙箱").await?;
        let status = map_status(&sandbox.status).ok_or_else(|| {
            GatewayError::Unknown(format!("未知生命周期状态：{}", sandbox.status))
        })?;
        Ok(GatewaySandboxView {
            id: sandbox.id,
            status,
            endpoints: sandbox
                .endpoints
                .into_iter()
                .map(|e| EndpointView {
                    name: e.name,
                    port: e.port,
                    address: e.address,
                })
                .collect(),
        })
    }

    /// 契约「控制面路由」：DELETE /api/v1/sandboxes/{id}，202 带删除意图。
    ///
    /// confirmed 语义（文档化）：
    /// - 202：删除意图已受理但资源尚未删除，confirmed=false，本域保留
    ///   ReleasePending 经 get 核实（完成后查询 404）；
    /// - **404：视为已删除，confirmed=true**（重复释放的幂等完成路径）；
    /// - 其他状态码/网络故障按统一规则映射。
    async fn release(&self, sandbox_id: &str) -> Result<ReleaseReceipt, GatewayError> {
        match self
            .classify(
                "释放沙箱",
                reqwest::Method::DELETE,
                self.sandbox_url(sandbox_id),
                None,
                None,
                true,
            )
            .await
        {
            Ok(_) => {
                // 202 受理：删除意图确认受理，资源删除异步完成，本域
                // 保留 ReleasePending 经 get 核实（完成后查询 404）。
                Ok(ReleaseReceipt { confirmed: false })
            }
            Err(GatewayError::Deleted(_)) => {
                // 404 视为已删除：confirmed=true（重复释放的幂等完成路径）。
                Ok(ReleaseReceipt { confirmed: true })
            }
            Err(e) => Err(e),
        }
    }
}

#[cfg(test)]
mod tests;
