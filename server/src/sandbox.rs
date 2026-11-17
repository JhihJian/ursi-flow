//! kernel 侧沙箱生命周期编排。
//!
//! 面向 engine 提供环境句柄与生命周期编排：经 sandbox-gateway 控制面创建
//! 与释放沙箱，经运行面端点直连沙箱完成命令执行、输入注入、输出与产物
//! 收集，并管理沙箱内 git 仓库工作区与凭据注入。
//!
//! 本模块是 sandbox-gateway 控制面 REST 契约（C1）在 kernel 侧的客户端，
//! 含 `SandboxControl` trait 的两个实现：gateway HTTP 客户端（生产形态）
//! 与 in-process fake（无 Docker 环境的开发与测试），engine 不感知差异。

use async_trait::async_trait;

/// 沙箱控制入口：面向运行的沙箱生命周期编排。
#[async_trait]
pub trait SandboxControl: Send + Sync {
    /// 为一次运行准备沙箱环境，返回控制面沙箱 ID。
    async fn prepare(&self, run_id: &str) -> Result<String, SandboxError>;
    /// 释放一次运行的沙箱；释放失败不阻塞运行终态。
    async fn release(&self, run_id: &str) -> Result<(), SandboxError>;
}

/// 沙箱编排错误。
#[derive(Debug, thiserror::Error)]
pub enum SandboxError {
    #[error("控制面调用失败：{0}")]
    Gateway(String),
    #[error("沙箱不存在：{0}")]
    NotFound(String),
    #[error("功能尚未实现：{0}")]
    NotImplemented(String),
}
