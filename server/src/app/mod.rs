mod config;
mod daemon;

use crate::{flow::FlowService, transport};
use std::io;
use tokio::{
    net::TcpListener,
    signal::unix::{SignalKind, signal},
    sync::oneshot,
};
use ursi_flow_client::FlowClient;

pub async fn run() -> io::Result<()> {
    let config = config::Config::from_env()?;
    let mut term = signal(SignalKind::terminate())?;
    let mut interrupt = signal(SignalKind::interrupt())?;
    let listener = TcpListener::bind(config.listen).await?;
    let mut child = daemon::start(&config).await?;
    let client = FlowClient::new(config.home.join("runtime.sock"));
    let service = FlowService::new(crate::flow::FlowClient::new(client), config.workspace);
    let router = transport::router(service, config.token, config.static_root);
    let (shutdown, drain) = oneshot::channel();
    let mut http = tokio::spawn(async move {
        axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = drain.await;
            })
            .await
    });
    tokio::select! {
        _ = term.recv() => (),
        _ = interrupt.recv() => (),
        exited = child.wait() => return Err(io::Error::other(format!("ursi-flowd 提前退出: {}", exited?))),
        res = &mut http => {
            daemon::stop(&mut child).await?;
            return res.map_err(io::Error::other)?;
        }
    }
    let _ = shutdown.send(());
    // Do not let an idle HTTP connection keep an executing flow alive indefinitely.
    match tokio::time::timeout(std::time::Duration::from_secs(3), &mut http).await {
        Ok(res) => {
            daemon::stop(&mut child).await?;
            res.map_err(io::Error::other)?
        }
        Err(_) => {
            http.abort();
            daemon::stop(&mut child).await
        }
    }
}
