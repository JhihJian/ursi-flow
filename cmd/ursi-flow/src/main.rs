//! ursi-flow 主程序入口。
//!
//! 骨架阶段：后续在这里装配 store / runner / sandbox / events 的具体实现，
//! 组装 `Engine`，并调用 `ursi_api::serve` 启动 HTTP 服务。

#[tokio::main]
async fn main() {
    println!("ursi-flow 流程执行引擎启动（骨架）");
}
