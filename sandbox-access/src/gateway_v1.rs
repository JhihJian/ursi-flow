//! Server 私有的 Gateway v1 控制面客户端。202 只表示受理；就绪与删除确认
//! 由业务层结合 GET 的观测结果和本地操作身份判断。

mod wire;

use std::time::Duration;

use async_trait::async_trait;
use flow_core::sandboxes::{
    GatewayClient, GatewayError, GatewaySandboxView, PrepareReceipt, PrepareStatus, ReleaseReceipt,
    SandboxSpec,
};
use reqwest::{Method, RequestBuilder, StatusCode, Url};

pub struct HttpGatewayClient {
    http: reqwest::Client,
    base_url: String,
    token: String,
}

impl std::fmt::Debug for HttpGatewayClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HttpGatewayClient")
            .field("token", &"***")
            .finish_non_exhaustive()
    }
}

impl HttpGatewayClient {
    pub fn new(base_url: impl Into<String>, token: impl Into<String>, timeout: Duration) -> Self {
        Self {
            http: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(timeout)
                .build()
                .expect("构造 Gateway HTTP 客户端"),
            base_url: base_url.into(),
            token: token.into(),
        }
    }

    fn request(&self, method: Method, id: Option<&str>) -> Result<RequestBuilder, GatewayError> {
        let invalid_url = || GatewayError::Protocol("Gateway 基地址非法".into());
        let mut url = Url::parse(&self.base_url).map_err(|_| invalid_url())?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(invalid_url());
        }
        {
            let mut path = url.path_segments_mut().map_err(|_| invalid_url())?;
            path.pop_if_empty().extend(["api", "v1", "sandboxes"]);
            if let Some(id) = id {
                if !wire::valid_id(id) {
                    return Err(GatewayError::Protocol("请求的沙箱标识无效".into()));
                }
                path.push(id);
            }
        }
        Ok(self.http.request(method, url).bearer_auth(&self.token))
    }

    async fn sandbox(
        &self,
        request: RequestBuilder,
        expected: StatusCode,
        id: Option<&str>,
    ) -> Result<wire::Sandbox, GatewayError> {
        let response = request.send().await.map_err(|e| {
            if e.is_builder() {
                GatewayError::Protocol("无法构造 Gateway 请求".into())
            } else {
                GatewayError::Unknown(format!("Gateway 请求结果未知：{}", e.without_url()))
            }
        })?;
        let status = response.status();
        if status != expected && !(status.is_client_error() || status.is_server_error()) {
            return Err(GatewayError::Protocol(format!(
                "Gateway 返回 HTTP {status}，预期 {expected}"
            )));
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|_| GatewayError::Unknown("未完整收到 Gateway 响应".into()))?;
        if status != expected {
            let detail = serde_json::from_slice::<wire::ErrorBody>(&bytes)
                .ok()
                .map(|body| body.error);
            // 业务层可依据 NotFound 确认删除；普通代理/路由返回的裸 404 不是该证据。
            if status == StatusCode::NOT_FOUND
                && !detail.as_ref().is_some_and(|e| e.code == "not_found")
            {
                return Err(GatewayError::Protocol(
                    "Gateway 404 缺少资源不存在的契约错误".into(),
                ));
            }
            let message = detail.map_or_else(
                || format!("HTTP {status}"),
                |e| format!("HTTP {status}：{}", e.message),
            );
            return Err(match status {
                StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
                    GatewayError::Unauthorized(message)
                }
                StatusCode::NOT_FOUND => GatewayError::NotFound(message),
                StatusCode::CONFLICT => GatewayError::Conflict(message),
                _ => GatewayError::Failed(message),
            });
        }
        let sandbox: wire::Sandbox = serde_json::from_slice(&bytes)
            .map_err(|_| GatewayError::Protocol("Gateway Sandbox 响应不符合 v1 契约".into()))?;
        sandbox.validate(id)?;
        Ok(sandbox)
    }
}

#[async_trait]
impl GatewayClient for HttpGatewayClient {
    async fn prepare(
        &self,
        operation_id: &str,
        spec: &SandboxSpec,
    ) -> Result<PrepareReceipt, GatewayError> {
        if operation_id.trim().is_empty() || operation_id.trim() != operation_id {
            return Err(GatewayError::Protocol("创建操作的幂等键无效".into()));
        }
        let request = self
            .request(Method::POST, None)?
            .header("Idempotency-Key", operation_id)
            .json(&wire::Create::try_from(spec)?);
        let sandbox = self.sandbox(request, StatusCode::ACCEPTED, None).await?;
        Ok(PrepareReceipt {
            operation_id: operation_id.to_owned(),
            sandbox_id: Some(sandbox.id),
            status: PrepareStatus::Accepted,
        })
    }

    async fn get(&self, sandbox_id: &str) -> Result<GatewaySandboxView, GatewayError> {
        let request = self.request(Method::GET, Some(sandbox_id))?;
        Ok(self
            .sandbox(request, StatusCode::OK, Some(sandbox_id))
            .await?
            .into())
    }

    async fn release(&self, sandbox_id: &str) -> Result<ReleaseReceipt, GatewayError> {
        let request = self.request(Method::DELETE, Some(sandbox_id))?;
        let sandbox = self
            .sandbox(request, StatusCode::ACCEPTED, Some(sandbox_id))
            .await?;
        if !sandbox.has_delete_intent() {
            return Err(GatewayError::Protocol(
                "Gateway 释放回执缺少删除意图".into(),
            ));
        }
        Ok(ReleaseReceipt { confirmed: false })
    }
}

#[cfg(test)]
mod response_tests;
#[cfg(test)]
mod tests;
