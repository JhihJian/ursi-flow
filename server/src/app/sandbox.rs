//! HTTP、MCP 与运行收尾共用的运行关联沙箱服务。

use std::sync::Arc;

use async_trait::async_trait;
use flow_core::runs::{ResourceReleaseError, ResourceReleaser};
use flow_core::sandboxes::{
    AccessError, ChannelAccessError, ChannelGateway, ChannelTarget, CommandOutcome,
    DomainSandboxState, FrozenSandboxConfig, GatewayClient, GatewayError, PlatformView,
    SandboxService, SandboxServiceError, SandboxStore, TerminalHandle,
};

use super::AppConfig;
use crate::transport::{ApiError, PrepareSandboxRequest, SandboxDto, SandboxesApi};

type Service = SandboxService<Arc<dyn GatewayClient>, UnboundChannels>;

enum Backend {
    Offline(SandboxStore),
    #[cfg(feature = "sandbox-access")]
    Online(Service),
}

pub(super) struct SandboxesApiAdapter {
    backend: Backend,
}

impl SandboxesApiAdapter {
    pub(super) fn new(store: SandboxStore, config: &AppConfig) -> Result<Self, String> {
        let backend = match &config.gateway {
            None => Backend::Offline(store),
            #[cfg(not(feature = "sandbox-access"))]
            Some(_) => return Err("配置了 Gateway，但当前构建未启用 sandbox-access".into()),
            #[cfg(feature = "sandbox-access")]
            Some(gateway) => {
                let url: axum::http::Uri = gateway.url.parse().map_err(|_| "Gateway 地址无效")?;
                if !matches!(url.scheme_str(), Some("http" | "https"))
                    || url.host().is_none()
                    || url.authority().is_some_and(|a| a.as_str().contains('@'))
                    || url.query().is_some()
                    || gateway.url.contains('#')
                {
                    return Err("Gateway 地址无效".into());
                }
                if gateway.key.trim().is_empty()
                    || !gateway.key.bytes().all(|b| b.is_ascii_graphic())
                    || gateway.timeout.is_zero()
                {
                    return Err("Gateway 凭据或超时配置无效".into());
                }
                let client = sandbox_access::gateway_v1::HttpGatewayClient::new(
                    gateway.url.clone(),
                    gateway.key.clone(),
                    gateway.timeout,
                );
                Backend::Online(SandboxService::new(
                    store,
                    Arc::new(diagnostics::SafeClient(client)),
                    UnboundChannels,
                ))
            }
        };
        Ok(Self { backend })
    }

    fn store(&self) -> &SandboxStore {
        match &self.backend {
            Backend::Offline(store) => store,
            #[cfg(feature = "sandbox-access")]
            Backend::Online(service) => service.store(),
        }
    }

    pub(super) async fn ready_view(&self, run_id: &str) -> Result<PlatformView, ApiError> {
        let view = self.online()?.status(run_id).await.map_err(|err| match err {
            SandboxServiceError::Access(AccessError::NotFound(_)) => unavailable("未找到运行关联的沙箱"),
            err => api_error(err),
        })?;
        // 身份文件按 view.run_id 寻址，不能使用另一运行的有效绑定。
        if view.run_id != run_id {
            return Err(unavailable("沙箱关联与请求运行不匹配"));
        }
        if view.state != DomainSandboxState::Ready {
            return Err(unavailable("运行关联的沙箱尚未就绪"));
        }
        Ok(view)
    }

    async fn release_view(&self, run_id: &str) -> Result<PlatformView, ApiError> {
        self.online()?.release(run_id).await.map_err(api_error)
    }

    fn online(&self) -> Result<&Service, ApiError> {
        match &self.backend {
            Backend::Offline(_) => Err(unavailable("未配置沙箱 Gateway")),
            #[cfg(feature = "sandbox-access")]
            Backend::Online(service) => Ok(service),
        }
    }
}

// 域会持久化错误诊断；自由文本在跨过控制面边界之前丢弃。
#[cfg(feature = "sandbox-access")]
mod diagnostics {
    use super::*;
    use flow_core::sandboxes::{GatewaySandboxView, PrepareReceipt, ReleaseReceipt, SandboxSpec};
    use sandbox_access::gateway_v1::HttpGatewayClient;

    pub(super) struct SafeClient(pub HttpGatewayClient);

    fn safe(error: GatewayError) -> GatewayError {
        use GatewayError::*;
        match error {
            Unauthorized(_) => Unauthorized("凭据被拒绝".into()),
            Protocol(_) => Protocol("响应不符合契约".into()),
            Conflict(_) => Conflict("请求冲突".into()),
            Unknown(_) => Unknown("请求结果待核实".into()),
            NotFound(_) => NotFound("资源不存在".into()),
            Failed(_) => Failed("请求失败".into()),
        }
    }

    #[async_trait]
    impl GatewayClient for SafeClient {
        async fn prepare(
            &self,
            operation_id: &str,
            spec: &SandboxSpec,
        ) -> Result<PrepareReceipt, GatewayError> {
            self.0.prepare(operation_id, spec).await.map_err(safe)
        }
        async fn get(&self, id: &str) -> Result<GatewaySandboxView, GatewayError> {
            self.0.get(id).await.map_err(safe)
        }
        async fn release(&self, id: &str) -> Result<ReleaseReceipt, GatewayError> {
            self.0.release(id).await.map_err(safe)
        }
    }
}

fn to_dto(view: PlatformView, last_observed: bool) -> SandboxDto {
    SandboxDto {
        id: view.sandbox_id.unwrap_or_default(),
        run_id: view.run_id,
        status: view.state.as_str().into(),
        endpoint: view.endpoints.into_iter().next().map(|e| e.address),
        last_observed,
        updated_at: view.updated_at,
    }
}

fn unavailable(reason: &'static str) -> ApiError {
    ApiError::SandboxUnavailable {
        message: reason.into(),
    }
}

// Gateway 错误可能包含上游返回的文本。仅传播分类，不把文本写入响应或清理诊断。
fn api_error(err: SandboxServiceError) -> ApiError {
    use SandboxServiceError::{Access, Control, Gateway};
    match err {
        Access(AccessError::NotFound(_)) | Control(GatewayError::NotFound(_)) => {
            ApiError::not_found("沙箱")
        }
        Access(AccessError::NotAvailable(_)) | Control(GatewayError::Conflict(_)) => {
            ApiError::conflict("沙箱关联或操作冲突")
        }
        Control(GatewayError::Unauthorized(_)) => ApiError::GatewayUnauthorized,
        Control(GatewayError::Protocol(_)) => ApiError::GatewayProtocol,
        Control(GatewayError::Unknown(_)) => unavailable("Gateway 请求结果未知"),
        Control(GatewayError::Failed(_)) => unavailable("Gateway 拒绝沙箱请求"),
        Access(_) => unavailable("沙箱端点不可用"),
        Gateway(_) => ApiError::Internal,
    }
}

#[async_trait]
impl SandboxesApi for SandboxesApiAdapter {
    async fn prepare(&self, request: PrepareSandboxRequest) -> Result<SandboxDto, ApiError> {
        if request.run_id.trim().is_empty() {
            return Err(ApiError::bad_request("缺少运行标识"));
        }
        let spec = serde_json::from_value(request.spec)
            .map_err(|_| ApiError::bad_request("沙箱规格无效"))?;
        self.online()?
            .prepare(&request.run_id, &FrozenSandboxConfig { spec })
            .await
            .map(|v| to_dto(v, false))
            .map_err(api_error)
    }

    async fn get_sandbox(&self, run_id: &str) -> Result<SandboxDto, ApiError> {
        self.online()?
            .status(run_id)
            .await
            .map(|v| to_dto(v, false))
            .map_err(api_error)
    }

    async fn list_sandboxes(&self, run_id: Option<&str>) -> Result<Vec<SandboxDto>, ApiError> {
        let store = self.store();
        let views: Vec<PlatformView> = match run_id {
            Some(id) => store.platform_view(id).map(|v| v.into_iter().collect()),
            None => return Err(ApiError::bad_request("请指定归属运行 runId")),
        }
        .map_err(|_| ApiError::Internal)?;
        Ok(views.into_iter().map(|v| to_dto(v, true)).collect())
    }

    async fn release(&self, run_id: &str) -> Result<SandboxDto, ApiError> {
        self.release_view(run_id).await.map(|v| to_dto(v, false))
    }
}

#[async_trait]
impl ResourceReleaser for SandboxesApiAdapter {
    async fn release(&self, run_id: &str) -> Result<(), ResourceReleaseError> {
        let record = self
            .store()
            .request_record(run_id)
            .map_err(|_| ResourceReleaseError::Failed("无法读取本地沙箱关联".into()))?;
        let Some(record) = record else { return Ok(()) };
        if record.state == DomainSandboxState::Released {
            return Ok(());
        }
        if record.state == DomainSandboxState::ReleasePending && record.sandbox_id.is_some() {
            let service = self
                .online()
                .map_err(|e| ResourceReleaseError::Failed(e.message()))?;
            let observed = service
                .status(run_id)
                .await
                .map_err(|e| ResourceReleaseError::Failed(api_error(e).message()))?;
            if observed.state == DomainSandboxState::Released {
                return Ok(());
            }
        }
        let view = self
            .release_view(run_id)
            .await
            .map_err(|e| ResourceReleaseError::Failed(e.message()))?;
        if view.state == DomainSandboxState::Released {
            Ok(())
        } else {
            Err(ResourceReleaseError::Failed("沙箱释放尚未确认".into()))
        }
    }
}

/// 未装配与 Gateway 观测端点绑定的通道时，不能改用本地执行或默认连接。
struct UnboundChannels;

fn unbound() -> ChannelAccessError {
    ChannelAccessError::Unreachable("未配置绑定沙箱端点的通道".into())
}

#[async_trait]
impl ChannelGateway for UnboundChannels {
    async fn open_file_channel(
        &self,
        _: &ChannelTarget,
        _: &str,
        _: &[u8],
    ) -> Result<usize, ChannelAccessError> {
        Err(unbound())
    }
    async fn open_exec_channel(
        &self,
        _: &ChannelTarget,
        _: &str,
    ) -> Result<CommandOutcome, ChannelAccessError> {
        Err(unbound())
    }
    async fn open_terminal(
        &self,
        _: &ChannelTarget,
    ) -> Result<Box<dyn TerminalHandle>, ChannelAccessError> {
        Err(unbound())
    }
    async fn close_sandbox(&self, _: &str) {} // 未创建句柄。
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn local_mode_lists_without_gateway_and_does_not_reserve_on_rejection() {
        let config = AppConfig::for_test(Default::default());
        let adapter =
            SandboxesApiAdapter::new(SandboxStore::open(":memory:").unwrap(), &config).unwrap();
        let err = adapter
            .prepare(PrepareSandboxRequest {
                run_id: "run-local".into(),
                spec: serde_json::json!({ "image": "test" }),
            })
            .await
            .unwrap_err();
        assert_eq!(err.code(), "sandbox_unavailable");
        assert!(
            adapter
                .list_sandboxes(Some("run-local"))
                .await
                .unwrap()
                .is_empty()
        );
        ResourceReleaser::release(&adapter, "run-local")
            .await
            .unwrap();
    }

    #[test]
    fn gateway_errors_never_copy_upstream_text_to_api_or_cleanup() {
        const SECRET: &str = "Bearer upstream-secret";
        for (error, expected) in [
            (
                GatewayError::Unauthorized(SECRET.into()),
                "gateway_unauthorized",
            ),
            (GatewayError::Conflict(SECRET.into()), "conflict"),
            (
                GatewayError::Protocol(SECRET.into()),
                "gateway_protocol_error",
            ),
            (GatewayError::Unknown(SECRET.into()), "sandbox_unavailable"),
            (GatewayError::NotFound(SECRET.into()), "not_found"),
            (GatewayError::Failed(SECRET.into()), "sandbox_unavailable"),
        ] {
            let err = api_error(error.into());
            assert_eq!(err.code(), expected);
            assert!(!err.message().contains(SECRET));
        }
    }
}
