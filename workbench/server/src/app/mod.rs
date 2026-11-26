mod config;

use crate::transport;
use std::io;
use tokio::{
    net::TcpListener,
    signal::unix::{SignalKind, signal},
    sync::oneshot,
};

pub async fn run() -> io::Result<()> {
    let config = config::Config::from_env()?;
    let mut term = signal(SignalKind::terminate())?;
    let mut interrupt = signal(SignalKind::interrupt())?;
    let listener = TcpListener::bind(config.listen).await?;
    let work = crate::work::routes(config.home.join("work"))?;
    let router = transport::router(work, config.token);
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
        res = &mut http => return res.map_err(io::Error::other)?,
    }
    let _ = shutdown.send(());
    match tokio::time::timeout(std::time::Duration::from_secs(3), &mut http).await {
        Ok(res) => res.map_err(io::Error::other)?,
        Err(_) => {
            http.abort();
            Ok(())
        }
    }
}
