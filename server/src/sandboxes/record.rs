//! 请求记录的收敛变体：就地修改表达「读改写」的状态收敛。
//!
//! 这些方法只调整字段并刷新时间戳，落库统一由
//! [`SandboxStore::record_request`](crate::sandboxes::store::SandboxStore::record_request)
//! 完成，收敛语义集中一处。

use crate::sandboxes::state::{DomainSandboxState, RequestRecord};

/// 请求记录的收敛方法（service 读改写后统一落库）。
pub(crate) trait RequestRecordMut {
    /// 补充操作身份（新请求首次落库前）。
    fn with_operation_id(&mut self, operation_id: &str);
    /// 收敛为 PreparePending：受理但尚未回填沙箱标识。
    fn with_pending(&mut self);
    /// 收敛为 Ready：平台已回填沙箱标识。
    fn with_ready(&mut self, sandbox_id: &str);
    /// 收敛为 Unknown：请求结果未知，保留操作身份待核实。
    fn with_unknown(&mut self, reason: String);
    /// 准备失败：保留 PreparePending 与失败摘要，运行不能将其当作可执行环境。
    fn with_failure(&mut self, reason: String);
}

impl RequestRecordMut for RequestRecord {
    fn with_operation_id(&mut self, operation_id: &str) {
        self.prepare_operation_id = operation_id.to_string();
    }

    fn with_pending(&mut self) {
        self.state = DomainSandboxState::PreparePending;
        self.last_error = None;
        self.updated_at = crate::sandboxes::now_rfc3339();
    }

    fn with_ready(&mut self, sandbox_id: &str) {
        self.sandbox_id = Some(sandbox_id.to_string());
        self.state = DomainSandboxState::Ready;
        self.last_error = None;
        self.updated_at = crate::sandboxes::now_rfc3339();
    }

    fn with_unknown(&mut self, reason: String) {
        self.state = DomainSandboxState::Unknown;
        self.last_error = Some(reason);
        self.updated_at = crate::sandboxes::now_rfc3339();
    }

    fn with_failure(&mut self, reason: String) {
        self.state = DomainSandboxState::PreparePending;
        self.last_error = Some(reason);
        self.gateway_summary = Some("准备请求被拒绝".into());
        self.updated_at = crate::sandboxes::now_rfc3339();
    }
}
