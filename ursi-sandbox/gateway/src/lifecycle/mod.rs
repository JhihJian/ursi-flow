//! 元数据先于外部副作用提交，按沙箱互斥执行，并以稳定代际接回中断操作。
pub mod store;

use crate::{driver::Driver, models::*, registry::Registry};
use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    sync::{Arc, Mutex, RwLock, Weak},
    time::Duration,
};
use store::Store;
use tokio::{
    sync::{Mutex as AsyncMutex, watch},
    task::JoinSet,
};

#[derive(Debug, Clone, Copy)]
pub enum Action {
    Start,
    Stop,
    Delete,
    Rebuild { preserve_data: bool },
}

pub struct Service {
    store: Arc<Store>,
    driver: Arc<dyn Driver>,
    registry: Arc<RwLock<Registry>>,
    registry_path: Option<PathBuf>,
    locks: Mutex<HashMap<String, Weak<AsyncMutex<()>>>>,
    stopping: std::sync::atomic::AtomicBool,
}

impl Service {
    pub fn new(store: Arc<Store>, driver: Arc<dyn Driver>, registry: Arc<Registry>) -> Arc<Self> {
        Self::with_registry(store, driver, registry, None)
    }

    pub fn with_registry(
        store: Arc<Store>,
        driver: Arc<dyn Driver>,
        registry: Arc<Registry>,
        registry_path: Option<PathBuf>,
    ) -> Arc<Self> {
        Arc::new(Self {
            store,
            driver,
            registry: Arc::new(RwLock::new((*registry).clone())),
            registry_path,
            locks: Mutex::new(HashMap::new()),
            stopping: std::sync::atomic::AtomicBool::new(false),
        })
    }
    pub fn new_without_registry(store: Arc<Store>, driver: Arc<dyn Driver>) -> Arc<Self> {
        let registry = Registry::new(Default::default()).expect("empty registry is valid");
        Self::new(store, driver, Arc::new(registry))
    }

    pub fn registry(&self) -> Registry {
        self.registry
            .read()
            .expect("registry lock poisoned")
            .clone()
    }

    pub fn replace_registry(&self, registry: Registry) -> Result<()> {
        if let Some(path) = &self.registry_path {
            let temporary = path.with_extension("json.tmp");
            let content = serde_json::to_vec_pretty(&registry)
                .map_err(|error| Error::Internal(error.to_string()))?;
            fs::write(&temporary, content)
                .map_err(|error| Error::Unavailable(error.to_string()))?;
            fs::rename(&temporary, path).map_err(|error| Error::Unavailable(error.to_string()))?;
        }
        *self.registry.write().expect("registry lock poisoned") = registry;
        Ok(())
    }
    pub fn is_stopping(&self) -> bool {
        self.stopping.load(std::sync::atomic::Ordering::Acquire)
    }
    pub fn stop(&self) {
        self.stopping
            .store(true, std::sync::atomic::Ordering::Release);
    }
    fn ensure_accepting(&self) -> Result<()> {
        if self.is_stopping() {
            return Err(Error::Unavailable("Gateway 正在停止".into()));
        }
        Ok(())
    }
    pub fn driver_name(&self) -> &'static str {
        self.driver.name()
    }
    pub fn capabilities(&self) -> Capabilities {
        self.driver.capabilities()
    }
    fn lock_for(&self, id: &str) -> Arc<AsyncMutex<()>> {
        let mut locks = self.locks.lock().expect("sandbox lock map poisoned");
        if let Some(lock) = locks.get(id).and_then(Weak::upgrade) {
            return lock;
        }
        locks.retain(|_, lock| lock.strong_count() > 0);
        let lock = Arc::new(AsyncMutex::new(()));
        locks.insert(id.into(), Arc::downgrade(&lock));
        lock
    }
    pub fn get(&self, id: &str) -> Result<Sandbox> {
        self.store.get(id)
    }
    pub fn list(&self) -> Result<Vec<Sandbox>> {
        self.store.list()
    }
    fn declared_endpoints(&self, image: &str) -> Result<Vec<Endpoint>> {
        self.registry
            .read()
            .expect("registry lock poisoned")
            .expand_image_with_bundles(image)
            .map_err(|error| Error::Invalid(format!("注册表展开失败: {error}")))
            .map(|endpoints| {
                endpoints
                    .into_iter()
                    .map(|endpoint| Endpoint {
                        name: endpoint.name,
                        bundle: endpoint.bundle,
                        protocol: endpoint.protocol,
                        port: endpoint.port,
                        state: EndpointState::Declared,
                        ready: false,
                    })
                    .collect()
            })
    }
    pub async fn create(&self, mut spec: SandboxSpec, key: Option<String>) -> Result<Sandbox> {
        self.ensure_accepting()?;
        // Runtime 包只能来自管理员注册表。请求体中的 bundle 即使被内部调用方
        // 构造出来，也会在校验前覆盖，避免把可执行 root 代码交给创建者。
        let runtime_bundle = self
            .registry
            .read()
            .expect("registry lock poisoned")
            .runtime_for_image(&spec.image)
            .map_err(|error| Error::Invalid(format!("注册表展开失败: {error}")))?;
        spec.bundle = runtime_bundle.clone();
        self.driver.validate_spec(&spec)?;
        if key.as_ref().is_some_and(|v| v.is_empty() || v.len() > 256) {
            return Err(Error::Invalid("幂等键无效".into()));
        }
        let endpoints = self.declared_endpoints(&spec.image)?;
        let sandbox = Sandbox {
            id: uuid::Uuid::new_v4().simple().to_string(),
            spec,
            resource: Resource {
                generation: 1,
                data_generation: 1,
            },
            status: Status::Preparing,
            operation: Some(Operation::Create),
            retired: vec![],
            revision: 0,
            endpoints,
            error: None,
        };
        self.store.insert(&sandbox, key.as_deref())
    }
    pub async fn request(&self, id: &str, action: Action) -> Result<Sandbox> {
        self.ensure_accepting()?;
        let lock = self.lock_for(id);
        let _guard = lock
            .try_lock()
            .map_err(|_| Error::Conflict("沙箱操作执行中，请重试".into()))?;
        let mut sandbox = self.get(id)?;
        if let Some(operation) = &sandbox.operation {
            let same = matches!(
                (operation, action),
                (Operation::Start, Action::Start)
                    | (Operation::Stop, Action::Stop)
                    | (Operation::Delete, Action::Delete)
            );
            if same {
                return Ok(sandbox);
            }
            if !matches!(action, Action::Delete) {
                return Err(Error::Conflict("已有未完成操作".into()));
            }
        }
        match action {
            Action::Start => {
                if sandbox.status == Status::Running {
                    return Ok(sandbox);
                }
                sandbox.operation = Some(Operation::Start);
                sandbox.status = Status::Preparing;
            }
            Action::Stop => {
                if sandbox.status == Status::Stopped {
                    return Ok(sandbox);
                }
                sandbox.operation = Some(Operation::Stop);
                sandbox.status = Status::Preparing;
            }
            Action::Delete => {
                sandbox.operation = Some(Operation::Delete);
                sandbox.status = Status::Deleting;
            }
            Action::Rebuild { preserve_data } => {
                let capabilities = self.capabilities();
                if (preserve_data && !capabilities.rebuild_preserve_data)
                    || (!preserve_data && !capabilities.rebuild_destroy_data)
                {
                    return Err(Error::Unsupported("驱动不支持该重建方式".into()));
                }
                let previous = sandbox.resource;
                sandbox.retired.push(previous);
                sandbox.resource.generation = sandbox
                    .resource
                    .generation
                    .checked_add(1)
                    .ok_or_else(|| Error::Internal("generation overflow".into()))?;
                if !preserve_data {
                    sandbox.resource.data_generation = sandbox.resource.generation;
                }
                sandbox.operation = Some(Operation::Rebuild {
                    previous,
                    preserve_data,
                });
                sandbox.status = Status::Preparing;
            }
        }
        sandbox.error = None;
        self.store.update(&mut sandbox)?;
        Ok(sandbox)
    }
    pub async fn logs(&self, id: &str, tail: usize) -> Result<String> {
        if tail == 0 || tail > 5000 {
            return Err(Error::Invalid("tail 必须为1..5000".into()));
        }
        self.driver.logs(&self.get(id)?, tail).await
    }
    pub async fn resolve_endpoint(&self, id: &str, name: &str) -> Result<Endpoint> {
        self.resolve_target(id, name)
            .await
            .map(|(endpoint, _)| endpoint)
    }
    pub async fn resolve_target(&self, id: &str, name: &str) -> Result<(Endpoint, String)> {
        let lock = self.lock_for(id);
        let _guard = lock
            .try_lock()
            .map_err(|_| Error::Conflict("沙箱操作执行中".into()))?;
        let sandbox = self.get(id)?;
        if sandbox.operation.is_some() || sandbox.status != Status::Running {
            return Err(Error::Conflict("沙箱未就绪".into()));
        }
        let declared = sandbox
            .endpoints
            .iter()
            .find(|endpoint| endpoint.name == name)
            .ok_or_else(|| Error::NotFound(name.into()))?;
        let observed = self.driver.observe(&sandbox).await?;
        if !observed.running || observed.healthy == Some(false) {
            return Err(Error::Unavailable("沙箱实际不可用".into()));
        }
        let target = observed
            .endpoints
            .into_iter()
            .find(|endpoint| {
                endpoint.name == declared.name
                    && endpoint.bundle == declared.bundle
                    && endpoint.protocol == declared.protocol
                    && endpoint.port == declared.port
            })
            .ok_or_else(|| Error::NotFound(name.into()))?;
        Ok((declared.clone(), target.address))
    }
    async fn ready(&self, sandbox: &Sandbox, observed: Observed) -> Result<Vec<Endpoint>> {
        if !observed.running || observed.healthy == Some(false) {
            return Err(Error::Unavailable("容器或健康检查尚未就绪".into()));
        }
        let mut endpoints = Vec::with_capacity(sandbox.endpoints.len());
        for declared in &sandbox.endpoints {
            let observed = observed
                .endpoints
                .iter()
                .find(|endpoint| {
                    endpoint.name == declared.name
                        && endpoint.bundle == declared.bundle
                        && endpoint.protocol == declared.protocol
                        && endpoint.port == declared.port
                })
                .ok_or_else(|| Error::Unavailable(format!("必需端点 {} 未发现", declared.name)))?;
            let mut endpoint = declared.clone();
            endpoint.state = observed.state.clone();
            endpoint.ready = observed.ready;
            endpoints.push(endpoint);
        }
        Ok(endpoints)
    }
    /// 可被启动/周期对账与独立恢复测试调用。每轮最多执行一次操作推进。
    pub async fn reconcile(&self, id: &str) -> Result<()> {
        let lock = self.lock_for(id);
        let Ok(_guard) = lock.try_lock() else {
            return Ok(());
        };
        let mut sandbox = match self.get(id) {
            Err(Error::NotFound(_)) => return Ok(()),
            other => other?,
        };
        let result = self.advance(&mut sandbox).await;
        if let Err(error) = &result {
            // 操作意图始终保留。错误只用于诊断，不把瞬时故障误判为资源不存在。
            let message = error.to_string();
            if sandbox.error.as_ref() != Some(&message) {
                sandbox.error = Some(message);
                if sandbox.operation.is_none() {
                    sandbox.status = Status::Error;
                    sandbox.endpoints.clear();
                }
                self.store.update(&mut sandbox)?;
            }
        }
        result
    }
    async fn advance(&self, sandbox: &mut Sandbox) -> Result<()> {
        match sandbox.operation.clone() {
            Some(Operation::Delete) => {
                // 先停止/移除全部工作负载，再删除卷，兼容保数据重建中途被删除。
                for resource in sandbox
                    .retired
                    .iter()
                    .chain(std::iter::once(&sandbox.resource))
                {
                    self.driver.remove(&sandbox.id, *resource, false).await?;
                }
                for resource in sandbox
                    .retired
                    .iter()
                    .chain(std::iter::once(&sandbox.resource))
                {
                    self.driver.remove(&sandbox.id, *resource, true).await?;
                }
                return self.store.delete(sandbox);
            }
            Some(Operation::Stop) => {
                match self.driver.stop(sandbox).await {
                    Err(Error::NotFound(_)) => {}
                    other => other?,
                }
                sandbox.status = Status::Stopped;
                sandbox.endpoints.clear();
            }
            Some(Operation::Create) => {
                let observed = self.driver.ensure(sandbox).await?;
                sandbox.endpoints = self.ready(sandbox, observed).await?;
                sandbox.status = Status::Running;
            }
            Some(Operation::Start) => {
                self.driver.start(sandbox).await?;
                sandbox.endpoints = self
                    .ready(sandbox, self.driver.observe(sandbox).await?)
                    .await?;
                sandbox.status = Status::Running;
            }
            Some(Operation::Rebuild {
                previous,
                preserve_data,
            }) => {
                // previous 在请求受理时冻结，重试只清理旧代，绝不误删新代卷。
                self.driver
                    .remove(&sandbox.id, previous, !preserve_data)
                    .await?;
                let observed = self.driver.ensure(sandbox).await?;
                sandbox.endpoints = self.ready(sandbox, observed).await?;
                sandbox.status = Status::Running;
                sandbox.retired.clear();
            }
            None => {
                let observed = self.driver.observe(sandbox).await?;
                if observed.running {
                    sandbox.endpoints = self.ready(sandbox, observed).await?;
                    sandbox.status = Status::Running;
                } else {
                    sandbox.endpoints.clear();
                    sandbox.status = Status::Stopped;
                }
            }
        }
        sandbox.operation = None;
        sandbox.error = None;
        self.store.update(sandbox)
    }
    /// 有界后台任务；停止时取消进行中的CLI，已提交意图由下次启动继续处理。
    pub async fn run(self: Arc<Self>, mut stop: watch::Receiver<bool>) -> Result<()> {
        let mut tasks = JoinSet::new();
        let mut active = std::collections::HashSet::new();
        let mut cursor = 0usize;
        let mut tick = tokio::time::interval(Duration::from_secs(1));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let result = loop {
            if self.is_stopping() || *stop.borrow() {
                break Ok(());
            }
            tokio::select! {
                biased;
                changed = stop.changed() => { if changed.is_err() || *stop.borrow() { break Ok(()); } }
                Some(done) = tasks.join_next(), if !tasks.is_empty() => {
                    match done {
                        Ok(id) => { active.remove(&id); }
                        Err(error) => {
                            // 子任务 panic 后停止调度，交由进程重启恢复，不能永久漏掉 active ID。
                            break Err(Error::Internal(format!("gateway reconciliation task failed: {error}")));
                        }
                    }
                }
                _ = tick.tick() => {
                    match self.list() {
                        Ok(sandboxes) => {
                            let count = sandboxes.len();
                            if count > 0 {
                                for _ in 0..count {
                                    if tasks.len() >= 16 { break; }
                                    let sandbox = &sandboxes[cursor % count];
                                    cursor = (cursor + 1) % count;
                                    if !active.insert(sandbox.id.clone()) { continue; }
                                    let service = self.clone();
                                    let id = sandbox.id.clone();
                                    tasks.spawn(async move { let _ = service.reconcile(&id).await; id });
                                }
                            }
                        }
                        Err(error) => break Err(error),
                    }
                }
            }
        };
        self.stop();
        tasks.abort_all();
        while tasks.join_next().await.is_some() {}
        result
    }
}

#[cfg(test)]
mod tests;
