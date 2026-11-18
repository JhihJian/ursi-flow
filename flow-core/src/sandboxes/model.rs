//! 平台侧的冻结配置、关联与资源观测。配置的序列化用于本地持久化，
//! 对外协议由 sandbox-access 单独映射。

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// 端点的访问范围。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Visibility {
    Public,
    Internal,
}

/// 由镜像引导程序装配的冻结运行包。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BundleRef {
    pub url: String,
    pub sha256: String,
    pub min_image_level: u32,
}

/// 冻结的沙箱规格（对应契约 SandboxSpec）。
///
/// run_id 在本域内不进入规格：规格只描述资源形态，运行关联由本域
/// 数据库维护；幂等身份为服务生成的 prepare 操作标识。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SandboxSpec {
    /// 镜像引用，必填。
    pub image: String,
    #[serde(default)]
    pub command: Vec<String>,
    #[serde(default)]
    pub labels: BTreeMap<String, String>,
    #[serde(default)]
    pub bundle: Option<BundleRef>,
    #[serde(default)]
    pub runtime_profile: Option<String>,
    /// 端点声明。
    #[serde(default)]
    pub ports: Vec<PortSpec>,
    /// 内存上限 MiB（契约范围 16..65536）。
    #[serde(default)]
    pub memory_mb: Option<u32>,
    /// CPU 份额（大于 0 且不超过 128）。
    #[serde(default)]
    pub cpus: Option<f64>,
}

/// 端点声明（对应契约 SandboxSpec.ports 条目）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PortSpec {
    /// 端点名称，规格内不得重复。
    pub name: String,
    /// 容器内端口（1..65535）。
    pub port: u16,
    pub visibility: Visibility,
    /// 就绪判定：该端点可连接才视为准备完成。
    #[serde(default)]
    pub ready: bool,
}

/// 端点的平台视图（对应契约 Endpoint）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EndpointView {
    /// 端点名称。
    pub name: String,
    /// 容器内端口。
    pub port: u16,
    pub visibility: Visibility,
    /// 访问地址（public 为宿主映射地址，internal 为受控网络地址）。
    pub address: String,
}

/// 准备受理回执（对应契约 POST /api/v1/sandboxes → 202 Sandbox）。
///
/// `sandbox_id` 为空表示受理但尚未分配资源，须以 operation_id 继续核实。
#[derive(Debug, Clone, PartialEq)]
pub struct PrepareReceipt {
    /// 本次准备的操作身份（幂等键，受理回执中的操作记录）。
    pub operation_id: String,
    /// 受理回执中的沙箱标识；受理尚未分配资源时为 None。
    pub sandbox_id: Option<String>,
    /// 受理结果。
    pub status: PrepareStatus,
}

/// 准备受理结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrepareStatus {
    /// 已受理，后台调度中。
    Accepted,
    /// 受理并已就绪。
    Ready,
    /// 受理失败（不产生可执行环境）。
    Failed,
}

/// 平台侧沙箱视图（对应契约 Sandbox 的 server 侧投影）。
#[derive(Debug, Clone, PartialEq)]
pub struct GatewaySandboxView {
    /// 沙箱标识。
    pub id: String,
    /// 生命周期状态。
    pub status: GatewaySandboxStatus,
    /// 即使观测为 Running，尚有待处理操作也不能准入。
    pub operation_pending: bool,
    /// 端点快照。
    pub endpoints: Vec<EndpointView>,
}

/// Gateway 沙箱生命周期状态（对应契约 status 字段）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GatewaySandboxStatus {
    /// 资源创建中。
    Preparing,
    /// 运行中（就绪）。
    Running,
    /// 已停止。
    Stopped,
    /// 删除中。
    Deleting,
    /// 错误（安全摘要，不含驱动原始错误）。
    Error,
}

/// 释放回执（对应契约 DELETE /api/v1/sandboxes/{id} → 202 带删除意图）。
///
/// `confirmed = false` 表示删除已受理但尚未确认完成。
#[derive(Debug, Clone, PartialEq)]
pub struct ReleaseReceipt {
    /// 平台是否已确认资源不存在。
    pub confirmed: bool,
}
