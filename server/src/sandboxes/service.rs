//! 核心服务：准备与关联、状态查询与释放、文件与连接接入。
//!
//! 一致性语义（DESIGN「资源与会话」）：Gateway 拥有沙箱实际生命周期，
//! 本服务保存平台侧关联和请求结果；释放请求失败或结果未知时保留
//! 待核实状态，通过 Gateway 查询与幂等操作确认。server 不维护第二套
//! 资源恢复状态机：本地状态的每次收敛都以 Gateway 的实际响应为准，
//! 平台查询失败不覆盖先前记录。
//!
//! 连接接入语义（SPEC「文件与连接接入」）：不存在或未就绪的沙箱
//! 拒绝访问，错误身份与不可达端点返回可区分错误；连接中断返回连接
//! 故障，不自动重试上层任务；释放后句柄回收，连接关闭不被当作远端
//! 任务取消（错误类型区分，见 [`error::AccessError`]）。

use uuid::Uuid;

use crate::sandboxes::error::{AccessError, GatewayError, SandboxServiceError};
use crate::sandboxes::model::{PrepareReceipt, PrepareStatus, ReleaseReceipt, SandboxSpec};
use crate::sandboxes::record::RequestRecordMut;
use crate::sandboxes::state::{DomainSandboxState, PlatformView, RequestRecord};
use crate::sandboxes::store::SandboxStore;
use crate::sandboxes::traits::channel::{
    ChannelAccessError, ChannelGateway, ChannelTarget, CommandOutcome, TerminalHandle,
};
use crate::sandboxes::traits::gateway::GatewayClient;

/// 冻结沙箱配置：运行发起准备时提交的资源形态（供查询与重试校验）。
#[derive(Debug, Clone, PartialEq)]
pub struct FrozenSandboxConfig {
    /// 冻结的沙箱规格。
    pub spec: SandboxSpec,
}

/// 沙箱服务：运行域的沙箱生命周期编排与访问接入。
pub struct SandboxService<G: GatewayClient, C: ChannelGateway> {
    store: SandboxStore,
    gateway: G,
    channels: C,
}

impl<G: GatewayClient, C: ChannelGateway> SandboxService<G, C> {
    /// 由本域存储与依赖网关构造。依赖经构造注入（DESIGN「公开边界」）。
    pub fn new(store: SandboxStore, gateway: G, channels: C) -> Self {
        Self { store, gateway, channels }
    }

    /// 本域存储句柄（协作方查询关联时使用）。
    pub fn store(&self) -> &SandboxStore {
        &self.store
    }

    /// 为一次运行准备沙箱环境。
    ///
    /// - 已有确认关联直接复用（重复提交幂等，不额外分配资源）；
    /// - 否则生成操作身份（uuid）调 Gateway 准备并落库；
    /// - 结果未知（响应丢失、超时）时本地记录 Unknown 并保留操作身份，
    ///   后续重试复用相同身份，经 Gateway 查询核实后恢复正确关联。
    pub async fn prepare(
        &self,
        run_id: &str,
        config: &FrozenSandboxConfig,
    ) -> Result<PlatformView, SandboxServiceError> {
        let spec_json = spec_json(config)?;
        if let Some((_sandbox_id, existing_json)) = self.store.confirmed_link(run_id)? {
            if existing_json != spec_json {
                return Err(SandboxServiceError::Access(AccessError::NotAvailable(format!(
                    "运行 {run_id} 已确认关联其他沙箱规格，拒绝替换",
                ))));
            }
            return self.refresh_view(run_id).await;
        }

        // 无确认关联：复用待收敛记录的操作身份（结果未知重试），或生成新身份。
        let existing = self.store.request_record(run_id)?;
        let (operation_id, mut base) = match &existing {
            Some(record) => {
                if record.spec_json != spec_json {
                    return Err(SandboxServiceError::Access(AccessError::NotAvailable(format!(
                        "运行 {run_id} 的待收敛请求绑定其他沙箱规格，拒绝替换",
                    ))));
                }
                (record.prepare_operation_id.clone(), record.clone())
            }
            None => (
                Uuid::new_v4().to_string(),
                RequestRecord {
                    run_id: run_id.to_string(),
                    sandbox_id: None,
                    prepare_operation_id: String::new(),
                    state: DomainSandboxState::PreparePending,
                    spec_json,
                    gateway_summary: None,
                    last_error: None,
                    updated_at: String::new(),
                },
            ),
        };
        if base.prepare_operation_id.is_empty() {
            base.with_operation_id(&operation_id);
        }
        self.dispatch_prepare(base).await
    }

    /// 查询运行的平台视图：本地关联加 Gateway 实时状态。
    ///
    /// 未知关联返回 NotFound；Unknown 记录先经 Gateway 核实再返回。
    pub async fn status(&self, run_id: &str) -> Result<PlatformView, SandboxServiceError> {
        let record = self
            .store
            .request_record(run_id)?
            .ok_or_else(|| SandboxServiceError::Access(AccessError::NotFound(run_id.to_string())))?;
        if record.state == DomainSandboxState::Unknown {
            return self.reconcile(run_id, record).await;
        }
        self.refresh_view(run_id).await
    }

    /// 请求释放一次运行的沙箱。
    ///
    /// - 未确认（confirmed=false 或结果未知）保留 ReleasePending，可查询、
    ///   可重试，不报告资源已释放；
    /// - 已完成的释放再请求幂等成功；
    /// - 平台查询失败不覆盖先前记录为虚假终态。
    pub async fn release(&self, run_id: &str) -> Result<PlatformView, SandboxServiceError> {
        let record = self
            .store
            .request_record(run_id)?
            .ok_or_else(|| SandboxServiceError::Access(AccessError::NotFound(run_id.to_string())))?;
        match record.state {
            DomainSandboxState::Released => return self.refresh_view(run_id).await,
            DomainSandboxState::PreparePending | DomainSandboxState::Unknown => {
                return Err(SandboxServiceError::Gateway(format!(
                    "运行 {run_id} 的准备请求尚未确认关联，先核实再释放",
                )));
            }
            _ => {}
        }
        let sandbox_id = record.sandbox_id.clone().expect("Ready/ReleasePending 记录保证沙箱标识存在");

        // 回收通道准入与句柄：释放与连接关闭回收本地资源，后续访问返回
        // AccessClosed，连接关闭不被当作远端任务取消（不通知运行取消）。
        self.channels.close_sandbox(&sandbox_id).await;
        self.store.clear_access_grant(run_id)?;

        match self.gateway.release(&sandbox_id).await {
            Ok(ReleaseReceipt { confirmed: true }) => {
                self.store.record_released(run_id)?;
            }
            Ok(ReleaseReceipt { confirmed: false }) => {
                self.store.update_state(
                    run_id,
                    DomainSandboxState::ReleasePending,
                    Some(format!("释放意图未被确认受理（沙箱 {sandbox_id}）")),
                )?;
            }
            Err(GatewayError::Unknown(reason)) => {
                self.store.update_state(
                    run_id,
                    DomainSandboxState::ReleasePending,
                    Some(format!("释放结果未知：{reason}")),
                )?;
            }
            Err(e) => {
                self.store.update_state(
                    run_id,
                    DomainSandboxState::ReleasePending,
                    Some(format!("释放请求失败：{e}")),
                )?;
            }
        }
        self.refresh_view(run_id).await
    }

    /// 上传输入文件：不存在或未就绪拒绝访问，调用通道网关时传正确目标身份。
    pub async fn transfer_file(
        &self,
        run_id: &str,
        path: &str,
        bytes: &[u8],
    ) -> Result<usize, SandboxServiceError> {
        let target = self.access_target(run_id).await?;
        match self.channels.open_file_channel(&target, path, bytes).await {
            Ok(len) => Ok(len),
            Err(e) => Err(SandboxServiceError::Access(map_channel_error(e))),
        }
    }

    /// 执行命令：返回输出与退出状态。
    pub async fn exec_command(
        &self,
        run_id: &str,
        cmd: &str,
    ) -> Result<CommandOutcome, SandboxServiceError> {
        let target = self.access_target(run_id).await?;
        match self.channels.open_exec_channel(&target, cmd).await {
            Ok(outcome) => Ok(outcome),
            Err(e) => Err(SandboxServiceError::Access(map_channel_error(e))),
        }
    }

    /// 打开交互终端连接：返回可显式回收的句柄。
    pub async fn open_terminal(
        &self,
        run_id: &str,
    ) -> Result<Box<dyn TerminalHandle>, SandboxServiceError> {
        let target = self.access_target(run_id).await?;
        match self.channels.open_terminal(&target).await {
            Ok(handle) => Ok(handle),
            Err(e) => Err(SandboxServiceError::Access(map_channel_error(e))),
        }
    }

    /// 回收一次运行的通道准入与句柄（运行收尾调用；不改变平台关联）。
    pub async fn close_access(&self, run_id: &str) -> Result<(), SandboxServiceError> {
        let record = self
            .store
            .request_record(run_id)?
            .ok_or_else(|| SandboxServiceError::Access(AccessError::NotFound(run_id.to_string())))?;
        if let Some(sandbox_id) = &record.sandbox_id {
            self.channels.close_sandbox(sandbox_id).await;
        }
        self.store.clear_access_grant(run_id)?;
        Ok(())
    }

    /// 访问目标：仅 Ready 关联放行（不存在、未就绪、未知与规格不一致
    /// 返回可区分错误）；准入端点经准入表下发。
    async fn access_target(&self, run_id: &str) -> Result<ChannelTarget, SandboxServiceError> {
        let record = self
            .store
            .request_record(run_id)?
            .ok_or_else(|| SandboxServiceError::Access(AccessError::NotFound(run_id.to_string())))?;
        if record.state != DomainSandboxState::Ready {
            return Err(SandboxServiceError::Access(match record.state {
                DomainSandboxState::Unknown => AccessError::Unknown(format!(
                    "运行 {run_id} 的沙箱身份尚未核实，拒绝访问",
                )),
                _ => AccessError::NotReady(format!(
                    "运行 {run_id} 的关联状态为 {}，拒绝访问",
                    record.state.as_str(),
                )),
            }));
        }
        let endpoint = self.store.access_grant(run_id)?;
        self.store.record_grant(run_id, endpoint.as_deref())?;
        let sandbox_id = record.sandbox_id.expect("Ready 记录保证沙箱标识存在");
        Ok(ChannelTarget { sandbox_id, endpoint })
    }

    /// 刷新平台视图：实时查询 Gateway 并更新快照；查询失败保留先前记录。
    async fn refresh_view(&self, run_id: &str) -> Result<PlatformView, SandboxServiceError> {
        let record = self
            .store
            .request_record(run_id)?
            .ok_or_else(|| SandboxServiceError::Access(AccessError::NotFound(run_id.to_string())))?;
        if let Some(sandbox_id) = &record.sandbox_id {
            if let Ok(view) = self.gateway.get(sandbox_id).await {
                self.store.update_gateway_snapshot(run_id, Some(view.status), Some(endpoints_json(&view.endpoints)?))?;
            }
        }
        Ok(self.store.platform_view(run_id)?.expect("记录存在"))
    }

    /// 发起准备：受理回执收敛本地状态；结果未知保留 Unknown 待核实。
    async fn dispatch_prepare(&self, mut record: RequestRecord) -> Result<PlatformView, SandboxServiceError> {
        let spec: SandboxSpec = serde_json::from_str(&record.spec_json)
            .map_err(|e| SandboxServiceError::Gateway(format!("解释沙箱规格失败：{e}")))?;
        match self.gateway.prepare(&record.prepare_operation_id, &spec).await {
            Ok(PrepareReceipt { sandbox_id, status, .. }) => match (status, sandbox_id) {
                (PrepareStatus::Failed, _) => {
                    record.with_failure(format!("Gateway 拒绝准备请求（操作 {}）", record.prepare_operation_id));
                    self.store.record_request(&record)?;
                }
                (_, Some(sandbox_id)) => {
                    record.with_ready(&sandbox_id);
                    self.store.record_request(&record)?;
                    return self.refresh_view(&record.run_id).await;
                }
                // 受理但未回填沙箱标识：PreparePending，经查询核实。
                _ => {
                    record.with_pending();
                    self.store.record_request(&record)?;
                }
            },
            // 结果未知：本地记录 Unknown，保留操作身份待重试核实。
            Err(GatewayError::Unknown(reason)) => {
                record.with_unknown(reason);
                self.store.record_request(&record)?;
            }
            Err(e) => {
                record.with_failure(e.to_string());
                self.store.record_request(&record)?;
            }
        }
        Ok(self.store.platform_view(&record.run_id)?.expect("准备请求已落库"))
    }

    /// Unknown 记录核实：以相同操作身份重试，经 Gateway 查询恢复关联。
    async fn reconcile(
        &self,
        run_id: &str,
        record: RequestRecord,
    ) -> Result<PlatformView, SandboxServiceError> {
        let spec: SandboxSpec = serde_json::from_str(&record.spec_json)
            .map_err(|e| SandboxServiceError::Gateway(format!("解释沙箱规格失败：{e}")))?;
        match self
            .gateway
            .prepare(&record.prepare_operation_id, &spec)
            .await
        {
            Ok(PrepareReceipt { sandbox_id, .. }) => {
                if let Some(sandbox_id) = &sandbox_id {
                    let mut record = record;
                    record.with_ready(sandbox_id);
                    self.store.record_request(&record)?;
                    return self.refresh_view(&record.run_id).await;
                }
            }
            // 受理被拒保留 Unknown 待核实，不覆盖为失败终态。
            Err(GatewayError::Failed(_)) => {}
            Err(GatewayError::Conflict(id)) => {
                let mut record = record;
                record.state = DomainSandboxState::Unknown;
                record.last_error = Some(format!("操作身份 {} 绑定冲突：{id}", record.prepare_operation_id));
                self.store.record_request(&record)?;
            }
            Err(GatewayError::Unknown(_)) => {}
        }
        Ok(self.store.platform_view(run_id)?.expect("记录存在"))
    }
}

/// 规格序列化；失败映射为服务错误。
fn spec_json(config: &FrozenSandboxConfig) -> Result<String, SandboxServiceError> {
    serde_json::to_string(&config.spec)
        .map_err(|e| SandboxServiceError::Gateway(format!("序列化沙箱规格失败：{e}")))
}

/// 端点快照序列化；失败映射为服务错误。
fn endpoints_json(endpoints: &[crate::sandboxes::model::EndpointView]) -> Result<String, SandboxServiceError> {
    serde_json::to_string(endpoints)
        .map_err(|e| SandboxServiceError::Gateway(format!("序列化端点失败：{e}")))
}

/// 通道错误映射：连接故障与不可达端点保持可区分。
fn map_channel_error(err: ChannelAccessError) -> AccessError {
    match err {
        ChannelAccessError::Connection(m) => AccessError::Connection(m),
        ChannelAccessError::Auth(m) => AccessError::Auth(m),
        ChannelAccessError::Unreachable(m) => AccessError::Unreachable(m),
        ChannelAccessError::NotAvailable(m) => AccessError::NotAvailable(m),
        ChannelAccessError::Closed(m) => AccessError::AccessClosed(m),
    }
}
