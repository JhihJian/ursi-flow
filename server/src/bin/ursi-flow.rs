//! ursi-flow 主程序入口。
//!
//! 装配 server 的各实现：database（SQLite）、agent-cli-adapter（mock 或真实
//! CLI）、sandbox（gateway HTTP 客户端或 in-process fake）、事件总线，组装
//! Engine 与 handlers，启动 HTTP 服务。sandbox-gateway 是独立二进制
//! （ursi-gateway crate），不在此装配。

#[tokio::main]
async fn main() {
    println!("ursi-flow server 启动（骨架）");
}
