//! 主服务装配与生命周期。
//!
//! 集中创建存储、领域服务、Agent Runtime、Channel 和协议入口。
//! 真实 CLI Adapter 由沙箱内 session-service 装配。
//! 当前保留原有启动占位行为，服务启动与关闭验收见 SPEC.md。

/// 主程序入口，完整依赖装配在应用模块内实现。
pub async fn run() {
    println!("ursi-flow server 启动（骨架）");
}
