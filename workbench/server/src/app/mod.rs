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
    let client = config
        .flow_enabled
        .then(|| FlowClient::new(config.home.join("runtime.sock")));
    let work = crate::work::routes(
        config.home.with_file_name("work"),
        config.workspace.clone(),
        client.clone(),
    )?;
    let mut child = if config.flow_enabled {
        Some(daemon::start(&config).await?)
    } else {
        None
    };
    let service =
        client.map(|c| FlowService::new(crate::flow::FlowClient::new(c), config.workspace));
    let router = transport::combined(service, work, config.token);
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
        exited = async { match child.as_mut() { Some(c) => c.wait().await, None => std::future::pending().await } } => return Err(io::Error::other(format!("ursi-flowd 提前退出: {}", exited?))),
        res = &mut http => {
            if let Some(c) = &mut child { daemon::stop(c).await?; }
            return res.map_err(io::Error::other)?;
        }
    }
    let _ = shutdown.send(());
    // Do not let an idle HTTP connection keep an executing flow alive indefinitely.
    match tokio::time::timeout(std::time::Duration::from_secs(3), &mut http).await {
        Ok(res) => {
            if let Some(c) = &mut child {
                daemon::stop(c).await?;
            }
            res.map_err(io::Error::other)?
        }
        Err(_) => {
            http.abort();
            match &mut child {
                Some(c) => daemon::stop(c).await,
                None => Ok(()),
            }
        }
    }
}
