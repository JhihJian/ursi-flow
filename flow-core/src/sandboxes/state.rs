//! 本域状态模型：关联状态、请求记录与平台视图。
//!
//! SPEC「交付与验收边界」：server 不维护第二套资源恢复状态机，
//! 资源实际生命周期归 Gateway。本地状态只表达「平台侧关联与请求
//! 结果」，结果未知时保留记录并经查询核实。

use serde::{Deserialize, Serialize};

use super::model::{EndpointView, GatewaySandboxStatus};

/// 本域关联状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DomainSandboxState {
    /// 准备身份已占用，但还没有可准入的实时观测。可以已经有沙箱标识。
    PreparePending,
    /// 最近一次 GET 返回匹配标识、running 且没有待处理操作。新准入仍须实时核实。
    Ready,
    /// 已持久化释放意图，但尚未确认资源消失。可查询、可重试。
    ReleasePending,
    /// 释放已确认完成，关联保留作幂等依据。
    Released,
    /// 结果未知：请求已发出但结果无法确认，须核实后收敛。
    Unknown,
}

impl DomainSandboxState {
    /// 存储序列化文本。
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::PreparePending => "PreparePending",
            Self::Ready => "Ready",
            Self::ReleasePending => "ReleasePending",
            Self::Released => "Released",
            Self::Unknown => "Unknown",
        }
    }

    /// 解析存储文本；未知值保留为 Unknown（不丢弃记录）。
    pub fn parse(text: &str) -> Self {
        match text {
            "PreparePending" => Self::PreparePending,
            "Ready" => Self::Ready,
            "ReleasePending" => Self::ReleasePending,
            "Released" => Self::Released,
            _ => Self::Unknown,
        }
    }
}

/// 请求记录：「请求身份」的持久化形式，支持结果未知后的幂等重试。
#[derive(Debug, Clone, PartialEq)]
pub struct RequestRecord {
    /// 运行标识（本域关联键）。
    pub run_id: String,
    /// Gateway 沙箱标识。尚未回填时为 None，释放后保留以供核对。
    pub sandbox_id: Option<String>,
    /// 准备操作身份（幂等键，跨重试与进程重启稳定）。
    pub prepare_operation_id: String,
    /// 本域关联状态。
    pub state: DomainSandboxState,
    /// 冻结沙箱规格 JSON（重试时校验规格一致性）。
    pub spec_json: String,
    /// 最近平台操作摘要（受控文本，不含驱动原始错误）。
    pub gateway_summary: Option<String>,
    /// 最近一次失败原因（仅诊断用，可区分状态由 state 表达）。
    pub last_error: Option<String>,
    /// 记录更新时间。
    pub updated_at: String,
}

/// 平台视图：本地关联加最近平台快照（SPEC「状态查询与释放」）。
#[derive(Debug, Clone, PartialEq)]
pub struct PlatformView {
    /// 运行标识。
    pub run_id: String,
    /// Gateway 沙箱标识。
    pub sandbox_id: Option<String>,
    /// 本域关联状态。
    pub state: DomainSandboxState,
    /// 准备操作身份。
    pub prepare_operation_id: String,
    /// 最近一次平台侧状态快照（响应丢失时保持先前记录）。
    pub gateway_status: Option<GatewaySandboxStatus>,
    /// 最近一次端点快照。
    pub endpoints: Vec<EndpointView>,
    /// 最近错误摘要。
    pub last_error: Option<String>,
    /// 记录更新时间。
    pub updated_at: String,
}
