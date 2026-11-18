//! Gateway 拥有资源生命周期。准备回执只能绑定身份，就绪与准入须经实时查询。
//! 释放意图先于外部调用落库，迟到的准备或查询响应不能撤销它。

use super::error::{AccessError, GatewayError, SandboxServiceError};
use super::model::{GatewaySandboxStatus, PrepareStatus, SandboxSpec};
use super::state::{DomainSandboxState as State, PlatformView, RequestRecord};
use super::store::SandboxStore;
use super::traits::channel::{
    ChannelAccessError, ChannelGateway, ChannelTarget, CommandOutcome, TerminalHandle,
};
use super::traits::gateway::GatewayClient;

/// 冻结沙箱配置：运行发起准备时提交的资源形态。
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
    /// 由本域存储与依赖网关构造。
    pub fn new(store: SandboxStore, gateway: G, channels: C) -> Self {
        Self {
            store,
            gateway,
            channels,
        }
    }

    /// 本域存储句柄（供离线查询最近观测）。
    pub fn store(&self) -> &SandboxStore {
        &self.store
    }

    /// 先占用身份和规格，再发准备请求。竞争者、重试和重启均使用已落库的记录。
    pub async fn prepare(
        &self,
        run_id: &str,
        config: &FrozenSandboxConfig,
    ) -> Result<PlatformView, SandboxServiceError> {
        // serde_json 会将非有限数编码为 null，不能让异常规格重放成默认 CPU。
        if config.spec.cpus.is_some_and(|cpus| !cpus.is_finite()) {
            return Err(GatewayError::Protocol("CPU 限制必须是有限数值".into()).into());
        }
        let spec_json = serde_json::to_string(&config.spec)
            .map_err(|e| SandboxServiceError::Gateway(format!("序列化沙箱规格失败：{e}")))?;
        let candidate = RequestRecord::reservation(run_id, spec_json);
        let record = self.store.reserve(&candidate)?;
        if record.spec_json != candidate.spec_json {
            return Err(AccessError::NotAvailable(format!(
                "运行 {run_id} 已绑定其他沙箱规格，拒绝替换"
            ))
            .into());
        }
        if matches!(record.state, State::ReleasePending | State::Released) {
            return self.local_view(run_id);
        }
        if record.sandbox_id.is_none() {
            // 创建的同步结果只有“受理”。不要让额外一次 GET 的失败掩盖受理，
            // 更不要把创建回执里的运行状态用作就绪证明。
            self.recover_id(&record).await?;
            return self.local_view(run_id);
        }
        self.reconcile(record).await
    }

    /// 有标识用 GET，无标识以冻结的身份和规格重放准备；已释放是本地终态。
    pub async fn status(&self, run_id: &str) -> Result<PlatformView, SandboxServiceError> {
        self.reconcile(self.record(run_id)?).await
    }

    async fn reconcile(
        &self,
        mut record: RequestRecord,
    ) -> Result<PlatformView, SandboxServiceError> {
        if record.state != State::Released && record.sandbox_id.is_none() {
            record = self.recover_id(&record).await?;
        }
        match &record.sandbox_id {
            Some(id) if record.state != State::Released => self.observe(&record, id).await,
            _ => self.local_view(&record.run_id),
        }
    }

    /// 只解释回执中的绑定关系。即使 POST 称已就绪也没有准入效力。
    async fn recover_id(
        &self,
        record: &RequestRecord,
    ) -> Result<RequestRecord, SandboxServiceError> {
        let spec: SandboxSpec = serde_json::from_str(&record.spec_json)
            .map_err(|e| SandboxServiceError::Gateway(format!("解释冻结沙箱规格失败：{e}")))?;
        let receipt = self
            .gateway
            .prepare(&record.prepare_operation_id, &spec)
            .await
            .map_err(|e| self.control_error(record, e))?;
        if receipt.operation_id != record.prepare_operation_id {
            return Err(self.control_error(
                record,
                GatewayError::Protocol("准备回执操作身份不匹配".into()),
            ));
        }
        if let Some(id) = &receipt.sandbox_id {
            if id.trim().is_empty() {
                return Err(self.control_error(
                    record,
                    GatewayError::Protocol("准备回执沙箱标识为空".into()),
                ));
            }
            self.store.bind_id(record, id)?;
        }
        let current = self.record(&record.run_id)?;
        if receipt.sandbox_id.is_some() && receipt.sandbox_id != current.sandbox_id {
            return Err(self.control_error(
                &current,
                GatewayError::Protocol("同一准备身份返回不同沙箱标识".into()),
            ));
        }
        if receipt.status == PrepareStatus::Failed {
            // 失败回执若携带 id，仍保留归属以便释放。不能被当作成功的准备。
            return Err(self.control_error(
                &current,
                GatewayError::Failed("Gateway 拒绝准备请求".into()),
            ));
        }
        Ok(current)
    }

    /// 实时观测。只有查询发起时已经处于已知资源的释放流程中，404 才确认完成。
    async fn observe(
        &self,
        record: &RequestRecord,
        id: &str,
    ) -> Result<PlatformView, SandboxServiceError> {
        let view = match self.gateway.get(id).await {
            Ok(view) => view,
            Err(GatewayError::NotFound(_)) if record.state == State::ReleasePending => {
                self.store.confirm_release(&record.run_id, id)?;
                return self.local_view(&record.run_id);
            }
            Err(err) => return Err(self.control_error(record, err)),
        };
        if view.id != id {
            return Err(self.control_error(
                record,
                GatewayError::Protocol("GET 返回的沙箱标识与关联不匹配".into()),
            ));
        }
        let ready = view.status == GatewaySandboxStatus::Running && !view.operation_pending;
        let endpoints = serde_json::to_string(&view.endpoints)
            .map_err(|e| SandboxServiceError::Gateway(format!("序列化端点失败：{e}")))?;
        match self
            .store
            .observe(&record.run_id, id, view.status, ready, &endpoints)?
        {
            Some(observed) => Ok(observed),
            None => self.local_view(&record.run_id), // GET 途中已完成释放。
        }
    }

    /// 释放前持久化意图。202 返回 ReleasePending；已不存在或后续 GET 404 才完成。
    pub async fn release(&self, run_id: &str) -> Result<PlatformView, SandboxServiceError> {
        let record = self
            .store
            .begin_release(run_id)?
            .ok_or_else(|| AccessError::NotFound(run_id.to_owned()))?;
        if record.state == State::Released {
            return self.local_view(run_id);
        }
        // 创建响应丢失后，Gateway 只能通过原键恢复资源 ID。释放重试本身
        // 即可核实，不依赖其他调用方先调用 status，也绝不使用新的幂等键。
        let record = if record.sandbox_id.is_none() {
            self.recover_id(&record).await?
        } else {
            record
        };
        let Some(id) = &record.sandbox_id else {
            return self.local_view(run_id);
        };
        if record.state == State::Released {
            return self.local_view(run_id);
        }
        self.channels.close_sandbox(id).await;
        match self.gateway.release(id).await {
            Ok(receipt) if !receipt.confirmed => (),
            Ok(_) | Err(GatewayError::NotFound(_)) => self.store.confirm_release(run_id, id)?,
            Err(err) => return Err(self.control_error(&record, err)),
        }
        self.local_view(run_id)
    }

    fn record(&self, run_id: &str) -> Result<RequestRecord, SandboxServiceError> {
        self.store
            .request_record(run_id)?
            .ok_or_else(|| AccessError::NotFound(run_id.to_owned()).into())
    }

    fn local_view(&self, run_id: &str) -> Result<PlatformView, SandboxServiceError> {
        self.store
            .platform_view(run_id)?
            .ok_or_else(|| AccessError::NotFound(run_id.to_owned()).into())
    }

    fn control_error(&self, record: &RequestRecord, err: GatewayError) -> SandboxServiceError {
        let state = if record.state == State::ReleasePending {
            State::ReleasePending
        } else if record.sandbox_id.is_none() && matches!(err, GatewayError::Failed(_)) {
            State::PreparePending
        } else {
            State::Unknown
        };
        match self.store.note_error(record, state, &err.to_string()) {
            Ok(()) => err.into(),
            Err(storage) => storage.into(),
        }
    }

    /// 上传输入文件。
    pub async fn transfer_file(
        &self,
        run_id: &str,
        path: &str,
        bytes: &[u8],
    ) -> Result<usize, SandboxServiceError> {
        let target = self.access_target(run_id).await?;
        Ok(self
            .channels
            .open_file_channel(&target, path, bytes)
            .await
            .map_err(map_channel_error)?)
    }

    /// 执行命令，返回输出与退出状态。
    pub async fn exec_command(
        &self,
        run_id: &str,
        cmd: &str,
    ) -> Result<CommandOutcome, SandboxServiceError> {
        let target = self.access_target(run_id).await?;
        Ok(self
            .channels
            .open_exec_channel(&target, cmd)
            .await
            .map_err(map_channel_error)?)
    }

    /// 打开交互终端连接，返回可显式回收的句柄。
    pub async fn open_terminal(
        &self,
        run_id: &str,
    ) -> Result<Box<dyn TerminalHandle>, SandboxServiceError> {
        let target = self.access_target(run_id).await?;
        Ok(self
            .channels
            .open_terminal(&target)
            .await
            .map_err(map_channel_error)?)
    }

    /// 回收一次运行的通道准入与句柄，不改变关联。
    pub async fn close_access(&self, run_id: &str) -> Result<(), SandboxServiceError> {
        if let Some(id) = self.record(run_id)?.sandbox_id {
            self.channels.close_sandbox(&id).await;
        }
        self.store.clear_access_grant(run_id)?;
        Ok(())
    }

    async fn access_target(&self, run_id: &str) -> Result<ChannelTarget, SandboxServiceError> {
        let record = self.record(run_id)?;
        let not_ready = || AccessError::NotReady(format!("运行 {run_id} 的沙箱尚未就绪或正在释放"));
        if matches!(record.state, State::Released | State::ReleasePending) {
            return Err(not_ready().into());
        }
        let Some(id) = &record.sandbox_id else {
            return Err(if record.state == State::Unknown {
                AccessError::Unknown(run_id.to_owned())
            } else {
                not_ready()
            }
            .into());
        };
        let view = self.observe(&record, id).await?;
        if view.state != State::Ready {
            return Err(not_ready().into());
        }
        let endpoint = self.store.access_grant(run_id)?;
        if !self.store.record_grant(run_id, id, endpoint.as_deref())? {
            return Err(not_ready().into());
        }
        Ok(ChannelTarget {
            sandbox_id: id.clone(),
            endpoint,
        })
    }
}

fn map_channel_error(err: ChannelAccessError) -> AccessError {
    match err {
        ChannelAccessError::Connection(m) => AccessError::Connection(m),
        ChannelAccessError::Auth(m) => AccessError::Auth(m),
        ChannelAccessError::Unreachable(m) => AccessError::Unreachable(m),
        ChannelAccessError::NotAvailable(m) => AccessError::NotAvailable(m),
        ChannelAccessError::Closed(m) => AccessError::AccessClosed(m),
    }
}
