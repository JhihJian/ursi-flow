//! 工具面错误契约。

use crate::mcp::domains::DomainId;

/// 注入后端返回的失败：域实现将其包装为 [`ToolError::Execution`]。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct BackendFailure {
    pub message: String,
}

impl BackendFailure {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

/// 工具装配或调用过程中的错误。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ToolError {
    #[error("未知工具：{name}")]
    UnknownTool { name: String },
    #[error("内部工具域调用缺少运行上下文")]
    MissingInvocationContext,
    #[error("上下文缺少节点身份，无法定位节点资源")]
    MissingNodeIdentity,
    #[error("内部工具域禁止通过参数传入运行身份：{keys:?}")]
    ForbiddenIdentityArgs { keys: Vec<String> },
    #[error("越权引用：资源 {resource} 属于运行 {owner_run}，当前上下文运行 {context_run}")]
    CrossRunAccess {
        resource: String,
        owner_run: String,
        context_run: String,
    },
    #[error("工具 {tool} 参数无效：{message}")]
    InvalidArgs { tool: String, message: String },
    #[error("工具 {tool} 执行失败：{message}")]
    Execution { tool: String, message: String },
}
/// server 装配域实现时的错误。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AssemblyError {
    #[error("域重复装配：{domain}")]
    DuplicateDomain { domain: DomainId },
    #[error("工具名重复：{tool}（已由域 {existing} 注册，域 {incoming} 再次注册）")]
    DuplicateTool {
        tool: String,
        existing: DomainId,
        incoming: DomainId,
    },
}
