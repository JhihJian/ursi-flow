#[tokio::main]
async fn main() -> std::io::Result<()> {
    ursi_server::app::run().await
}
