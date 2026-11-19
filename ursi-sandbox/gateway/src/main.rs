use std::{future::IntoFuture, path::Path, process::ExitCode, sync::Arc, time::Duration};
use ursi_gateway::{
    driver::Driver,
    gateway_api,
    lifecycle::{Service, store::Store},
    models::{Error, Result},
    registry::{Registry, RegistryError},
};

fn env(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.into())
}

#[tokio::main]
async fn main() -> ExitCode {
    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("Gateway 运行失败: {error}");
            ExitCode::FAILURE
        }
    }
}
async fn run() -> Result<()> {
    let key = env("URSI_GATEWAY_KEY", "");
    if key.len() < 16 || key.bytes().any(|b| b.is_ascii_whitespace()) {
        return Err(Error::Invalid(
            "URSI_GATEWAY_KEY 至少16字节且不能含空白".into(),
        ));
    }
    let name = env("URSI_GATEWAY_DRIVER", "docker");
    let namespace = env("URSI_GATEWAY_NAMESPACE", "ursi");
    let (driver, identity): (Arc<dyn Driver>, String) = match name.as_str() {
        #[cfg(feature = "driver-docker")]
        "docker" => {
            let driver =
                ursi_gateway::driver::docker::DockerDriver::connect(namespace.clone()).await?;
            let driver = if let Some(path) = std::env::var_os("URSI_GATEWAY_RUNTIME_PROFILES") {
                driver.with_runtime_profiles(ursi_gateway::driver::profiles::RuntimeProfiles::load(
                    Path::new(&path),
                )?)
            } else {
                driver
            };
            let identity = format!("docker:{namespace}:{}", driver.identity());
            (Arc::new(driver), identity)
        }
        #[cfg(feature = "driver-fake")]
        "fake" => (
            Arc::new(ursi_gateway::driver::fake::FakeDriver::new()),
            format!("fake:{namespace}"),
        ),
        _ => return Err(Error::Invalid("驱动未知或未编译".into())),
    };
    let store = Arc::new(Store::open(Path::new(&env(
        "URSI_GATEWAY_DB",
        "./gateway.sqlite",
    )))?);
    store.bind_identity(&identity)?;
    let registry_path =
        Path::new(&env("URSI_GATEWAY_REGISTRY", "./gateway-registry.json")).to_owned();
    let registry = match Registry::load(&registry_path) {
        Ok(registry) => registry,
        Err(RegistryError::Io(_)) if !registry_path.exists() => {
            Registry::new(Default::default()).expect("empty registry is valid")
        }
        Err(error) => return Err(Error::Invalid(format!("Gateway registry 无效: {error}"))),
    };
    let service = Service::with_registry(store, driver, Arc::new(registry), Some(registry_path));
    let tunnel = match env("URSI_GATEWAY_TUNNEL", "false").as_str() {
        "true" => true,
        "false" => false,
        _ => return Err(Error::Invalid("URSI_GATEWAY_TUNNEL 应为 true/false".into())),
    };
    let listener = tokio::net::TcpListener::bind(env("URSI_GATEWAY_BIND", "0.0.0.0:8899"))
        .await
        .map_err(|e| Error::Unavailable(e.to_string()))?;
    // 在发布监听地址前安装信号处理器，避免启动就绪与 SIGTERM 之间的竞态。
    #[cfg(unix)]
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .map_err(|error| Error::Internal(error.to_string()))?;
    let signal = async move {
        #[cfg(unix)]
        tokio::select! {
            result = tokio::signal::ctrl_c() => result,
            _ = term.recv() => Ok(()),
        }
        #[cfg(not(unix))]
        tokio::signal::ctrl_c().await
    };
    println!(
        "ursi-gateway listening on {}",
        listener
            .local_addr()
            .map_err(|e| Error::Internal(e.to_string()))?
    );
    let (stop, rx) = tokio::sync::watch::channel(false);
    let mut worker = tokio::spawn(service.clone().run(rx));
    let (http_stop, http_stopped) = tokio::sync::oneshot::channel();
    let app = gateway_api::router(service.clone(), key, tunnel);
    let mut server = Box::pin(
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = http_stopped.await;
            })
            .into_future(),
    );
    let result = tokio::select! {
        result = &mut worker => {
            match result {
                Ok(Err(error)) => Err(error),
                Ok(Ok(())) => Err(Error::Internal("Gateway 调度意外停止".into())),
                Err(error) => Err(Error::Internal(format!("Gateway 调度任务失败: {error}"))),
            }
        }
        result = &mut server => {
            match result {
                Ok(()) => Err(Error::Internal("Gateway HTTP 服务意外停止".into())),
                Err(error) => Err(Error::Unavailable(error.to_string())),
            }
        }
        signal = signal => {
            service.stop();
            let _ = stop.send(true);
            let _ = http_stop.send(());
            match signal {
                Err(error) => Err(Error::Internal(error.to_string())),
                Ok(()) => {
                    // 慢请求体和背压连接不能无限延长退出。到期后销毁 server，
                    // main 返回时 runtime 取消剩余连接任务并释放其数据库引用。
                    match tokio::time::timeout(Duration::from_secs(3), async {
                        tokio::try_join!(
                            async {
                                (&mut worker).await
                                    .map_err(|error| Error::Internal(error.to_string()))?
                            },
                            async {
                                (&mut server).await
                                    .map_err(|error| Error::Unavailable(error.to_string()))
                            },
                        )?;
                        Ok(())
                    }).await {
                        Ok(result) => result,
                        Err(_) => {
                            eprintln!("Gateway HTTP 退出超时，强制关闭剩余连接");
                            Ok(())
                        }
                    }
                }
            }
        }
    };
    service.stop();
    let _ = stop.send(true);
    worker.abort();
    drop(server);
    result
}
