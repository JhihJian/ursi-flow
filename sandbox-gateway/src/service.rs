//! 生命周期编排：创建、就绪探测、恢复对账、孤儿 GC。
//!
//! 对齐 grasp gateway internal/service 的语义，首版范围裁剪为：
//! Create / Get / List / Start / Stop / Destroy / Status / Logs。
//! 不含：runtime bundle 热更新、reinstall、preview 代理、快照暂停。

/// 服务骨架占位：parity 移植 service.go 对应用例时填充。
pub struct SandboxService;
