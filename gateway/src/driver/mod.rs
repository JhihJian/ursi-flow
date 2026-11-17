//! 驱动抽象与实现。
//!
//! Driver 只管基础设施生命周期与端点暴露；数据面（exec、文件、日志流）
//! 不属于本接口，由 kernel 经运行面端点直连沙箱。

use async_trait::async_trait;

use crate::models::Status;

/// 创建沙箱的规格。
#[derive(Debug, Clone)]
pub struct Spec {
    pub image: String,
    pub env: Vec<(String, String)>,
    /// 需要暴露的容器端口。
    pub ports: Vec<u16>,
    pub labels: Vec<(String, String)>,
}

/// 沙箱句柄：驱动返回的就绪资源与端点。
#[derive(Debug, Clone)]
pub struct Handle {
    pub id: String,
    pub name: String,
    pub status: Status,
    /// 每个暴露端点的客户端可达地址。
    pub endpoints: Vec<(u16, String)>,
}

/// 驱动错误。
#[derive(Debug, thiserror::Error)]
pub enum DriverError {
    #[error("沙箱不存在：{0}")]
    NotFound(String),
    #[error("驱动错误：{0}")]
    Other(String),
}

/// 沙箱驱动：供应与暴露沙箱，生命周期 + 端点暴露。
/// 一个 gateway 实例启动时按配置选择唯一驱动。
#[async_trait]
pub trait Driver: Send + Sync {
    /// 驱动标识。
    fn name(&self) -> &'static str;

    /// 供应沙箱，底层资源创建后即返回（不保证就绪）。
    async fn create(&self, spec: &Spec) -> Result<Handle, DriverError>;

    /// 恢复已停止沙箱。
    async fn start(&self, id: &str) -> Result<(), DriverError>;

    /// 停止并保留沙箱。
    async fn stop(&self, id: &str) -> Result<(), DriverError>;

    /// 删除沙箱及其资源（尽力而为）。
    async fn destroy(&self, id: &str) -> Result<(), DriverError>;

    /// 刷新状态与端点。
    async fn get(&self, id: &str) -> Result<Handle, DriverError>;

    /// 列出本驱动管理的全部沙箱（用于对账）。
    async fn list(&self) -> Result<Vec<Handle>, DriverError>;

    /// 仅查询生命周期状态。
    async fn status(&self, id: &str) -> Result<Status, DriverError>;
}
