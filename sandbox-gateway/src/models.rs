//! 沙箱领域模型与生命周期状态。
//!
//! 对齐 grasp gateway internal/models 的语义：沙箱记录、状态机、创建规格。

/// 沙箱生命周期状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    /// 镜像拉取中。
    Pulling,
    /// 记录已持久化，容器创建中。
    Creating,
    /// 就绪，端点已回填。
    Running,
    /// 停止，保留元数据可恢复。
    Stopped,
    /// 停止已受理，资源释放未确认。
    Stopping,
    /// 删除意图已持久化，重试至驱动清理成功。
    Deleting,
    /// 创建或对账失败。
    Error,
}

/// 沙箱实例的持久化元数据。
#[derive(Debug, Clone)]
pub struct Sandbox {
    pub id: String,
    /// 驱动原生资源名（容器名）。
    pub name: String,
    pub status: Status,
    pub image: String,
    pub error: Option<String>,
    /// 暴露端口的地址表。
    pub endpoints: Vec<(u16, String)>,
    pub labels: Vec<(String, String)>,
}
