//! 请求身份和冻结规格只在首次占用运行时生成，此后的状态更新不改写它们。

use uuid::Uuid;

use super::state::{DomainSandboxState, RequestRecord};

impl RequestRecord {
    pub(super) fn reservation(run_id: &str, spec_json: String) -> Self {
        Self {
            run_id: run_id.to_owned(),
            sandbox_id: None,
            prepare_operation_id: Uuid::new_v4().to_string(),
            state: DomainSandboxState::PreparePending,
            spec_json,
            gateway_summary: None,
            last_error: None,
            updated_at: super::now_rfc3339(),
        }
    }
}
