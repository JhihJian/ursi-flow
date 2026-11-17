//! 沙箱域错误：区分网关结果、平台视图与访问接入三组语义。
//!
//! 「连接关闭不被当作远端任务取消」在错误类型上成立：通道被回收或中断
//! 归入 [`AccessError`]（连接故障，不自动重试上层任务），与网关结果
//! [`GatewayError`] 及运行关联 [`SandboxError`] 相互独立。

use thiserror::Error;

/// 沙箱编排错误：面向运行域的资源生命周期操作。
#[derive(Debug, Error)]
pub enum SandboxError {
    /// Gateway 调用失败或返回失败语义（运行不能将其当作可执行环境）。
    #[error("控制面调用失败：{0}")]
    Gateway(String),
    /// 运行在本地没有已确认的沙箱关联。
    #[error("沙箱不存在：{0}")]
    NotFound(String),
    /// 功能尚未实现。
    #[error("功能尚未实现：{0}")]
    NotImplemented(String),
}

/// Gateway 操作结果错误：受理被拒、操作身份冲突与结果未知三类可区分状态。
#[derive(Debug, Error)]
pub enum GatewayError {
    /// Gateway 拒绝受理（对应契约 4xx/5xx，含运行不能当作可执行环境的失败状态）。
    #[error("Gateway 拒绝请求：{0}")]
    Failed(String),
    /// 同一操作身份已绑定其他沙箱规格，重试被拒绝。
    #[error("操作身份冲突：{0}")]
    Conflict(String),
    /// 网络结果未知：响应丢失或超时，须保留记录并经查询核实。
    #[error("请求结果未知：{0}")]
    Unknown(String),
}

/// 连接接入错误：拒绝访问与连接故障两大类。
#[derive(Debug, Error)]
pub enum AccessError {
    /// 运行没有已确认的沙箱关联，拒绝访问。
    #[error("沙箱不存在：{0}")]
    NotFound(String),
    /// 关联尚未就绪，拒绝访问。
    #[error("沙箱尚未就绪：{0}")]
    NotReady(String),
    /// 结果未知（如响应丢失后未完成核实），拒绝访问。
    #[error("沙箱状态未知：{0}")]
    Unknown(String),
    /// 关联指向其他沙箱规格，拒绝访问。
    #[error("沙箱与请求的配置不一致：{0}")]
    NotAvailable(String),
    /// 本地句柄已被回收（显式关闭或释放），禁止继续使用。
    #[error("连接已回收：{0}")]
    AccessClosed(String),
    /// 连接故障（中断、鉴权失败或端点不可达），不自动重试上层任务。
    #[error("连接故障：{0}")]
    Connection(String),
    /// 端点鉴权失败。
    #[error("端点鉴权失败：{0}")]
    Auth(String),
    /// 端点不可达。
    #[error("端点不可达：{0}")]
    Unreachable(String),
}

/// 本域服务错误：平台视图、控制面操作与连接接入三类调用面。
#[derive(Debug, Error)]
pub enum SandboxServiceError {
    /// 平台视图查询或生命周期操作失败。
    #[error("沙箱状态或控制操作失败：{0}")]
    Gateway(String),
    /// 连接接入被拒绝或连接故障。
    #[error("连接接入失败：{0}")]
    Access(#[from] AccessError),
}

impl From<GatewayError> for SandboxServiceError {
    fn from(err: GatewayError) -> Self {
        SandboxServiceError::Gateway(err.to_string())
    }
}

impl From<StoreError> for SandboxServiceError {
    fn from(err: StoreError) -> Self {
        SandboxServiceError::Gateway(err.to_string())
    }
}

impl From<rusqlite::Error> for StoreError {
    fn from(err: rusqlite::Error) -> Self {
        StoreError::Storage(err.to_string())
    }
}

/// 本域存储错误。
#[derive(Debug, Error)]
pub enum StoreError {
    /// SQLite 操作失败。
    #[error("存储错误：{0}")]
    Storage(String),
}
