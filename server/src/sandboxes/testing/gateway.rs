//! Gateway 客户端替身：记录调用、注入故障，幂等键绑定规格与沙箱。

use std::collections::HashMap;
use std::sync::Mutex;

use crate::sandboxes::error::GatewayError;
use crate::sandboxes::model::{
    GatewaySandboxStatus, GatewaySandboxView, PrepareReceipt, PrepareStatus, ReleaseReceipt,
    SandboxSpec,
};
use crate::sandboxes::traits::gateway::GatewayClient;

/// Gateway 替身故障注入。
#[derive(Debug, Clone, Default)]
pub(crate) struct GatewayFailures {
    /// prepare 返回 Unknown（模拟响应丢失/超时）。
    pub prepare_unknown: bool,
    /// prepare 返回受理失败（PrepareStatus::Failed）。
    pub prepare_failed: bool,
    /// prepare 返回 Conflict。
    pub prepare_conflict: bool,
    /// get 返回 Unknown（平台查询结果未知）。
    pub get_unknown: bool,
    /// get 返回 Failed（对应 404/5xx 映射）。
    pub get_failed: bool,
    /// release 返回 confirmed=false。
    pub release_unconfirmed: bool,
    /// release 返回 Unknown。
    pub release_unknown: bool,
}

/// 调用记录：操作与关键参数。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum GatewayCall {
    /// (operation_id, spec_json)。
    Prepare(String, String),
    /// 查询的沙箱标识。
    Get(String),
    /// 释放的沙箱标识。
    Release(String),
}

struct Inner {
    /// 已受理的沙箱：id -> (spec_json, status, endpoints)。
    sandboxes: HashMap<String, (String, GatewaySandboxStatus)>,
    /// 幂等键 -> 沙箱标识（契约：同一创建幂等键绑定同一规格与沙箱）。
    idempotency: HashMap<String, String>,
    /// 受理顺序（供「不额外分配资源」断言）。
    created_order: Vec<String>,
    calls: Vec<GatewayCall>,
    failures: GatewayFailures,
    /// 受理时的初始状态。
    ready_status: GatewaySandboxStatus,
}

/// 可记录、可注入故障的 Gateway 客户端替身。
pub(crate) struct FakeGateway {
    inner: Mutex<Inner>,
}

impl FakeGateway {
    /// 创建替身：`ready` 为 true 时受理即回填沙箱标识并返回 Ready；
    /// 否则返回 Accepted（模拟受理后异步调度，查询 Preparing）。
    pub(crate) fn new(ready: bool) -> Self {
        let status = if ready {
            GatewaySandboxStatus::Running
        } else {
            GatewaySandboxStatus::Preparing
        };
        Self {
            inner: Mutex::new(Inner {
                sandboxes: HashMap::new(),
                idempotency: HashMap::new(),
                created_order: Vec::new(),
                calls: Vec::new(),
                failures: GatewayFailures::default(),
                ready_status: status,
            }),
        }
    }

    /// 注入故障组合。
    pub(crate) fn fail(&self, failures: GatewayFailures) {
        self.inner.lock().unwrap().failures = failures;
    }

    /// 调用记录快照。
    pub(crate) fn calls(&self) -> Vec<GatewayCall> {
        self.inner.lock().unwrap().calls.clone()
    }

    /// 累计分配的沙箱数量（验证重复提交不额外分配资源）。
    pub(crate) fn allocated(&self) -> usize {
        self.inner.lock().unwrap().created_order.len()
    }

    /// 令指定沙箱进入就绪状态（模拟异步调度完成）。
    #[allow(dead_code)]
    pub(crate) fn set_running(&self, sandbox_id: &str) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(entry) = inner.sandboxes.get_mut(sandbox_id) {
            entry.1 = GatewaySandboxStatus::Running;
        }
    }
}

#[async_trait::async_trait]
impl GatewayClient for FakeGateway {
    async fn prepare(
        &self,
        operation_id: &str,
        spec: &SandboxSpec,
    ) -> Result<PrepareReceipt, GatewayError> {
        let mut inner = self.inner.lock().unwrap();
        let spec_json = serde_json::to_string(spec).expect("替身规格序列化");
        inner
            .calls
            .push(GatewayCall::Prepare(operation_id.to_string(), spec_json.clone()));
        let failures = inner.failures.clone();
        if failures.prepare_unknown {
            // 契约语义：受理可能已落库（幂等键已绑定），响应在途中丢失。
            return Err(GatewayError::Unknown("模拟响应丢失".into()));
        }
        if failures.prepare_conflict {
            return Err(GatewayError::Conflict("该幂等键已绑定其他规格".into()));
        }
        if failures.prepare_failed {
            return Ok(PrepareReceipt {
                operation_id: operation_id.to_string(),
                sandbox_id: None,
                status: PrepareStatus::Failed,
            });
        }
        let sandbox_id = match inner.idempotency.get(operation_id) {
            Some(id) => id.clone(),
            None => {
                let id = format!("sbx_{}", inner.created_order.len() + 1);
                let initial_status = inner.ready_status;
                inner.created_order.push(id.clone());
                inner
                    .idempotency
                    .insert(operation_id.to_string(), id.clone());
                inner.sandboxes.insert(id.clone(), (spec_json, initial_status));
                id
            }
        };
        let status = inner.sandboxes[&sandbox_id].1;
        Ok(PrepareReceipt {
            operation_id: operation_id.to_string(),
            sandbox_id: Some(sandbox_id),
            status: if status == GatewaySandboxStatus::Running {
                PrepareStatus::Ready
            } else {
                PrepareStatus::Accepted
            },
        })
    }

    async fn get(&self, sandbox_id: &str) -> Result<GatewaySandboxView, GatewayError> {
        let mut inner = self.inner.lock().unwrap();
        inner.calls.push(GatewayCall::Get(sandbox_id.to_string()));
        if inner.failures.get_unknown {
            return Err(GatewayError::Unknown("模拟查询响应丢失".into()));
        }
        if inner.failures.get_failed {
            return Err(GatewayError::Failed("模拟平台查询失败".into()));
        }
        match inner.sandboxes.get(sandbox_id) {
            Some((_, status)) => Ok(GatewaySandboxView {
                id: sandbox_id.to_string(),
                status: *status,
                endpoints: Vec::new(),
            }),
            None => Err(GatewayError::Failed("沙箱不存在".into())),
        }
    }

    async fn release(&self, sandbox_id: &str) -> Result<ReleaseReceipt, GatewayError> {
        let mut inner = self.inner.lock().unwrap();
        inner.calls.push(GatewayCall::Release(sandbox_id.to_string()));
        let failures = inner.failures.clone();
        if failures.release_unknown {
            return Err(GatewayError::Unknown("模拟释放响应丢失".into()));
        }
        if failures.release_unconfirmed {
            return Ok(ReleaseReceipt { confirmed: false });
        }
        // 契约：带删除意图的 202，完成后查询 404（替身直接移除资源）。
        inner.sandboxes.remove(sandbox_id);
        Ok(ReleaseReceipt { confirmed: true })
    }
}
