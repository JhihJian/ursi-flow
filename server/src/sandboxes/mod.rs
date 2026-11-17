//! 沙箱域：平台资源关联、Gateway 请求与文件/命令通道接入。
//!
//! Gateway 拥有沙箱实际生命周期，本域保存运行与 Gateway 沙箱标识的
//! 关联及平台操作结果（DESIGN「资源与会话」）；Channel 提供连接与
//! 传输，Agent Runtime 管 agent 会话控制。
//!
//! 模块结构：
//! - [`error`]：`SandboxError`（编排错误）、`GatewayError`（受理拒绝、
//!   身份冲突与结果未知）、`AccessError`（访问拒绝与连接故障）、
//!   `SandboxServiceError`（服务调用面）；
//! - [`model`]：沙箱规格、受理回执、平台视图与释放回执（语义对齐
//!   Gateway 契约）；
//! - [`state`]：本域关联状态、请求记录与平台视图（请求身份持久化）；
//! - [`traits`]：`GatewayClient` 与 `ChannelGateway` 窄接口（真实实现由
//!   app 装配，测试注入替身，不引入 HTTP 客户端）；
//! - [`store`]：`SandboxStore`（rusqlite 直连，自管 sandboxes_domain 迁移）；
//! - [`record`]：请求记录的收敛变体（读改写的状态收敛）；
//! - [`service`]：`SandboxService`（准备与关联、状态查询与释放、
//!   文件与连接接入）；
//! - [`testing`]：Gateway 与 Channel 替身（仅测试编译）。
//!
//! 验收契约见 SPEC.md。

mod error;
mod model;
mod record;
mod service;
mod state;
pub mod store;
mod traits;

#[cfg(test)]
mod testing;
#[cfg(test)]
mod tests;

pub use error::{AccessError, GatewayError, SandboxError, SandboxServiceError, StoreError};
pub use model::{EndpointView, GatewaySandboxStatus, PrepareReceipt, PrepareStatus, ReleaseReceipt, SandboxSpec};
pub use service::{FrozenSandboxConfig, SandboxService};
pub use state::{DomainSandboxState, PlatformView, RequestRecord};
pub use store::SandboxStore;
pub use traits::{ChannelAccessError, ChannelGateway, ChannelTarget, CommandOutcome, GatewayClient, TerminalHandle};

/// 当前 UTC 时间戳（RFC 3339，秒精度；无 chrono 依赖，civ_days 算法）。
pub(crate) fn now_rfc3339() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("系统时钟早于 Unix 纪元");
    let total = now.as_secs();
    let days = total / 86_400;
    let secs_of_day = total % 86_400;
    let (h, m, s) = (secs_of_day / 3600, (secs_of_day % 3600) / 60, secs_of_day % 60);
    // civ_days 算法（Howard Hinnant）：1970-01-01 起的天数转 y-m-d。
    let z = (days + 719_468) as i64;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mth = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mth <= 2 { y + 1 } else { y };
    format!("{y:04}-{mth:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

/// 沙箱控制入口：面向运行的沙箱生命周期编排。
///
/// 完整能力由 [`SandboxService`] 提供；本 trait 是运行域调用的窄接口，
/// app 装配时以服务实现注入，独立测试可注入替身。
#[async_trait::async_trait]
pub trait SandboxControl: Send + Sync {
    /// 为一次运行准备沙箱环境，返回控制面沙箱 ID。
    async fn prepare(&self, run_id: &str) -> Result<String, SandboxError>;
    /// 请求释放一次运行的沙箱；失败必须显式返回，以便记录和重试。
    async fn release(&self, run_id: &str) -> Result<(), SandboxError>;
}
