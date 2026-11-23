use std::{env, io, net::SocketAddr, path::PathBuf};
use tokio::{
    net::TcpListener,
    signal::unix::{SignalKind, signal},
};
use ursi_executor_platform::work::{Tokens, application};

fn required(key: &str) -> io::Result<String> {
    env::var(key).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, format!("请设置 {key}")))
}

fn main() -> io::Result<()> {
    let args: Vec<_> = env::args_os().skip(1).collect();
    if let [mode, root, id, bin, policy] = args.as_slice()
        && mode == "--acp-worker"
    {
        return tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?
            .block_on(ursi_executor_platform::work::acp_worker(
                root.as_os_str().as_ref(),
                id.to_str().unwrap_or(""),
                bin.as_os_str().as_ref(),
                policy.as_os_str().as_ref(),
            ));
    }
    serve()
}

#[tokio::main]
async fn serve() -> io::Result<()> {
    let tokens = Tokens::new(
        required("URSI_EXECUTOR_PLATFORM_ADMIN_TOKEN")?,
        required("URSI_EXECUTOR_PLATFORM_WORKBENCH_TOKEN")?,
        required("URSI_EXECUTOR_PLATFORM_RUNTIME_TOKEN")?,
    )?;
    let dir = env::var_os("URSI_EXECUTOR_PLATFORM_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| "executor-platform-data".into());
    let address: SocketAddr = env::var("URSI_EXECUTOR_PLATFORM_LISTEN_ADDR")
        .unwrap_or_else(|_| "0.0.0.0:8081".into())
        .parse()
        .map_err(|_| io::Error::other("无效的平台监听地址"))?;
    let app = application(dir, tokens)?;
    let listener = TcpListener::bind(address).await?;
    let mut term = signal(SignalKind::terminate())?;
    let mut interrupt = signal(SignalKind::interrupt())?;
    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            tokio::select! { _ = term.recv() => (), _ = interrupt.recv() => () }
        })
        .await
}
