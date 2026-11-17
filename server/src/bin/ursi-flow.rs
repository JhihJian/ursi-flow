//! ursi-flow 二进制入口，应用装配归 app 模块。

#[tokio::main]
async fn main() {
    ursi_server::app::run().await;
}
