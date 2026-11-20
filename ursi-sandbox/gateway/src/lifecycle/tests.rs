use super::*;
use crate::driver::fake::FakeDriver;
use tempfile::TempDir;

fn spec() -> SandboxSpec {
    serde_json::from_value(serde_json::json!({"image":"alpine:3.22"})).unwrap()
}
fn setup() -> (TempDir, Arc<Store>, Arc<FakeDriver>, Arc<Service>) {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&dir.path().join("metadata.sqlite")).unwrap());
    let driver = Arc::new(FakeDriver::new());
    let service = Service::new_without_registry(store.clone(), driver.clone());
    (dir, store, driver, service)
}

#[tokio::test]
async fn lifecycle_with_frozen_spec_and_idempotency() {
    let (_dir, _store, driver, service) = setup();
    let created = service
        .create(spec(), Some("request-one".into()))
        .await
        .unwrap();
    assert_eq!(created.status, Status::Preparing);
    assert!(matches!(
        driver.observe(&created).await,
        Err(Error::NotFound(_))
    ));
    assert_eq!(
        service
            .create(spec(), Some("request-one".into()))
            .await
            .unwrap()
            .id,
        created.id
    );
    let mut other = spec();
    other.image = "other:version".into();
    assert!(matches!(
        service.create(other, Some("request-one".into())).await,
        Err(Error::Conflict(_))
    ));
    service.reconcile(&created.id).await.unwrap();
    assert_eq!(service.get(&created.id).unwrap().status, Status::Running);
    service.request(&created.id, Action::Stop).await.unwrap();
    service.reconcile(&created.id).await.unwrap();
    assert_eq!(service.get(&created.id).unwrap().status, Status::Stopped);
    service.request(&created.id, Action::Start).await.unwrap();
    service.reconcile(&created.id).await.unwrap();
    assert_eq!(service.get(&created.id).unwrap().spec, created.spec);
    service.request(&created.id, Action::Delete).await.unwrap();
    service.reconcile(&created.id).await.unwrap();
    assert!(matches!(service.get(&created.id), Err(Error::NotFound(_))));
    assert!(matches!(
        service.create(spec(), Some("request-one".into())).await,
        Err(Error::Conflict(_))
    ));
}

#[tokio::test]
async fn failed_query_does_not_delete_or_erase_intent() {
    let (_dir, _store, driver, service) = setup();
    let created = service.create(spec(), None).await.unwrap();
    service.reconcile(&created.id).await.unwrap();
    driver.fail_next("observe");
    assert!(service.reconcile(&created.id).await.is_err());
    assert_eq!(service.get(&created.id).unwrap().status, Status::Error);
    service.reconcile(&created.id).await.unwrap();
    service.request(&created.id, Action::Delete).await.unwrap();
    driver.fail_next("remove");
    assert!(service.reconcile(&created.id).await.is_err());
    assert!(matches!(
        service.get(&created.id).unwrap().operation,
        Some(Operation::Delete)
    ));
    let recovered = Service::new_without_registry(service.store.clone(), driver);
    recovered.reconcile(&created.id).await.unwrap();
    assert!(matches!(
        recovered.get(&created.id),
        Err(Error::NotFound(_))
    ));
}

#[tokio::test]
async fn crash_after_create_adopts_resource() {
    let (dir, store, driver, service) = setup();
    let created = service.create(spec(), None).await.unwrap();
    driver.fail_next("ensure_after_create");
    assert!(service.reconcile(&created.id).await.is_err());
    drop(service);
    drop(store);
    let store = Arc::new(Store::open(&dir.path().join("metadata.sqlite")).unwrap());
    let recovered = Service::new_without_registry(store, driver);
    recovered.reconcile(&created.id).await.unwrap();
    let current = recovered.get(&created.id).unwrap();
    assert_eq!(current.resource, created.resource);
    assert_eq!(current.status, Status::Running);
}

#[tokio::test]
async fn rebuild_generations_survive_partial_success_and_restart() {
    for preserve_data in [true, false] {
        let (dir, store, driver, service) = setup();
        let created = service.create(spec(), None).await.unwrap();
        service.reconcile(&created.id).await.unwrap();
        let rebuilding = service
            .request(&created.id, Action::Rebuild { preserve_data })
            .await
            .unwrap();
        assert_eq!(rebuilding.resource.generation, 2);
        assert_eq!(
            rebuilding.resource.data_generation,
            if preserve_data { 1 } else { 2 }
        );
        driver.fail_next("ensure_after_create");
        assert!(service.reconcile(&created.id).await.is_err());
        drop(service);
        drop(store);
        let store = Arc::new(Store::open(&dir.path().join("metadata.sqlite")).unwrap());
        let recovered = Service::new_without_registry(store, driver.clone());
        recovered.reconcile(&created.id).await.unwrap();
        let current = recovered.get(&created.id).unwrap();
        assert_eq!(current.resource, rebuilding.resource);
        assert!(current.operation.is_none());
        assert!(current.retired.is_empty());
        assert!(driver.observe(&current).await.unwrap().running);
    }
}

#[tokio::test]
async fn delete_during_failed_rebuild_cleans_both_generations() {
    let (_dir, _store, driver, service) = setup();
    let created = service.create(spec(), None).await.unwrap();
    service.reconcile(&created.id).await.unwrap();
    let rebuilding = service
        .request(
            &created.id,
            Action::Rebuild {
                preserve_data: true,
            },
        )
        .await
        .unwrap();
    driver.fail_next("remove");
    assert!(service.reconcile(&created.id).await.is_err());
    service.request(&created.id, Action::Delete).await.unwrap();
    service.reconcile(&created.id).await.unwrap();
    assert!(matches!(
        driver.observe(&created).await,
        Err(Error::NotFound(_))
    ));
    assert!(matches!(
        driver.observe(&rebuilding).await,
        Err(Error::NotFound(_))
    ));
}

#[tokio::test]
async fn conflicting_actions_are_rejected_before_side_effects() {
    let (_dir, _store, _driver, service) = setup();
    let created = service.create(spec(), None).await.unwrap();
    assert!(matches!(
        service
            .request(
                &created.id,
                Action::Rebuild {
                    preserve_data: false
                }
            )
            .await,
        Err(Error::Conflict(_))
    ));
    service.reconcile(&created.id).await.unwrap();
    service.request(&created.id, Action::Stop).await.unwrap();
    assert!(matches!(
        service.request(&created.id, Action::Start).await,
        Err(Error::Conflict(_))
    ));
}

#[tokio::test]
async fn readiness_requires_registered_endpoint_and_hides_internal_address() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&dir.path().join("metadata.sqlite")).unwrap());
    let driver = Arc::new(FakeDriver::new());
    let registry = Registry::from_json(
        r#"{"bundles":{"terminal":{"endpoints":[{"name":"ssh","protocol":"ssh","port":22}]}},"images":{"alpine:3.22":["terminal"]}}"#,
    )
    .unwrap();
    let service = Service::new(store, driver.clone(), Arc::new(registry));
    let created = service.create(spec(), None).await.unwrap();
    assert_eq!(created.endpoints.len(), 1);
    assert_eq!(created.endpoints[0].name, "ssh");
    service.reconcile(&created.id).await.unwrap();
    let current = service.get(&created.id).unwrap();
    assert_eq!(current.status, Status::Running);
    assert!(current.endpoints[0].ready);
    let (endpoint, address) = service.resolve_target(&created.id, "ssh").await.unwrap();
    assert_eq!(endpoint.name, "ssh");
    assert_eq!(address, "127.0.0.1:22");
    assert!(
        serde_json::to_value(&endpoint)
            .unwrap()
            .get("address")
            .is_none()
    );
    assert!(matches!(
        service.resolve_endpoint(&created.id, "unknown").await,
        Err(Error::NotFound(_))
    ));

    service
        .replace_registry(Registry::new(Default::default()).unwrap())
        .unwrap();
    let mut unavailable = endpoint.clone();
    unavailable.state = EndpointState::Unavailable;
    unavailable.ready = false;

    driver.fail_next("observe");
    assert!(service.reconcile(&created.id).await.is_err());
    let failed = service.get(&created.id).unwrap();
    assert_eq!(failed.status, Status::Error);
    assert_eq!(failed.endpoints, [unavailable.clone()]);
    service.reconcile(&created.id).await.unwrap();
    assert_eq!(
        service.resolve_endpoint(&created.id, "ssh").await.unwrap(),
        endpoint
    );

    service.request(&created.id, Action::Stop).await.unwrap();
    service.reconcile(&created.id).await.unwrap();
    service.reconcile(&created.id).await.unwrap();
    let stopped = service.get(&created.id).unwrap();
    assert_eq!(stopped.status, Status::Stopped);
    assert_eq!(stopped.endpoints, [unavailable]);
    service.request(&created.id, Action::Start).await.unwrap();
    service.reconcile(&created.id).await.unwrap();
    assert_eq!(
        service.resolve_endpoint(&created.id, "ssh").await.unwrap(),
        endpoint
    );
}

#[tokio::test]
async fn round_robin_reconciliation_reaches_more_than_sixteen_sandboxes() {
    let (_dir, _store, _driver, service) = setup();
    let mut ids = Vec::new();
    for _ in 0..33 {
        ids.push(service.create(spec(), None).await.unwrap().id);
    }
    let (stop, rx) = watch::channel(false);
    let worker = tokio::spawn(service.clone().run(rx));
    tokio::time::timeout(Duration::from_secs(7), async {
        loop {
            if ids
                .iter()
                .all(|id| service.get(id).unwrap().status == Status::Running)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("后排沙箱不得饥饿");
    stop.send(true).unwrap();
    worker.await.unwrap().unwrap();
}

struct PanicDriver(FakeDriver);

#[async_trait::async_trait]
impl Driver for PanicDriver {
    fn name(&self) -> &'static str {
        self.0.name()
    }
    fn capabilities(&self) -> Capabilities {
        self.0.capabilities()
    }
    async fn ensure(&self, _sandbox: &Sandbox) -> Result<Observed> {
        panic!("reconciliation panic for supervision test");
    }
    async fn start(&self, sandbox: &Sandbox) -> Result<()> {
        self.0.start(sandbox).await
    }
    async fn stop(&self, sandbox: &Sandbox) -> Result<()> {
        self.0.stop(sandbox).await
    }
    async fn remove(&self, id: &str, resource: Resource, remove_data: bool) -> Result<()> {
        self.0.remove(id, resource, remove_data).await
    }
    async fn observe(&self, sandbox: &Sandbox) -> Result<Observed> {
        self.0.observe(sandbox).await
    }
    async fn logs(&self, sandbox: &Sandbox, tail: usize) -> Result<String> {
        self.0.logs(sandbox, tail).await
    }
}

async fn assert_stopping_rejects_mutations(service: &Service, id: &str) {
    assert!(service.is_stopping());
    assert!(matches!(
        service.create(spec(), None).await,
        Err(Error::Unavailable(_))
    ));
    for action in [
        Action::Start,
        Action::Stop,
        Action::Delete,
        Action::Rebuild {
            preserve_data: true,
        },
    ] {
        assert!(matches!(
            service.request(id, action).await,
            Err(Error::Unavailable(_))
        ));
    }
}

#[tokio::test]
async fn supervision_reconciliation_panic_stops_and_rejects_mutations() {
    let (_dir, store, _driver, _service) = setup();
    let service = Service::new_without_registry(store, Arc::new(PanicDriver(FakeDriver::new())));
    let created = service.create(spec(), None).await.unwrap();
    let (_stop, rx) = watch::channel(false);
    let result = tokio::time::timeout(Duration::from_secs(2), service.clone().run(rx))
        .await
        .expect("panic must stop scheduling");
    assert!(
        matches!(result, Err(Error::Internal(message)) if message.contains("reconciliation task failed"))
    );
    assert_stopping_rejects_mutations(&service, &created.id).await;
    assert!(matches!(
        service.get(&created.id).unwrap().operation,
        Some(Operation::Create)
    ));
}

#[tokio::test]
async fn supervision_metadata_failure_stops_and_rejects_mutations() {
    let (dir, _store, _driver, service) = setup();
    let created = service.create(spec(), None).await.unwrap();
    let connection = rusqlite::Connection::open(dir.path().join("metadata.sqlite")).unwrap();
    connection
        .execute("UPDATE sandboxes SET body = 'invalid json'", [])
        .unwrap();
    let (_stop, rx) = watch::channel(false);
    let result = tokio::time::timeout(Duration::from_secs(2), service.clone().run(rx))
        .await
        .expect("metadata failure must stop scheduling");
    assert!(matches!(result, Err(Error::Internal(_))));
    assert_stopping_rejects_mutations(&service, &created.id).await;
}

#[tokio::test]
async fn supervision_normal_stop_returns_ok_and_rejects_mutations() {
    for already_stopped in [false, true] {
        let (_dir, _store, _driver, service) = setup();
        let created = service.create(spec(), None).await.unwrap();
        let (stop, rx) = watch::channel(already_stopped);
        let worker = tokio::spawn(service.clone().run(rx));
        if !already_stopped {
            tokio::task::yield_now().await;
            stop.send(true).unwrap();
        }
        tokio::time::timeout(Duration::from_secs(2), worker)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_stopping_rejects_mutations(&service, &created.id).await;
    }
}

#[cfg(unix)]
#[test]
fn database_symlink_alias_cannot_bypass_exclusive_lock() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let original = dir.path().join("db.sqlite");
    let _store = Store::open(&original).unwrap();
    let alias = dir.path().join("alias.sqlite");
    symlink(&original, &alias).unwrap();
    assert!(matches!(Store::open(&alias), Err(Error::Conflict(_))));
    let hard = dir.path().join("hard.sqlite");
    std::fs::hard_link(&original, &hard).unwrap();
    assert!(matches!(Store::open(&hard), Err(Error::Invalid(_))));
}

#[tokio::test]
async fn stale_cas_and_database_identity_are_enforced() {
    let (dir, store, _driver, service) = setup();
    let created = service.create(spec(), None).await.unwrap();
    let mut stale = created.clone();
    let mut current = created;
    store.update(&mut current).unwrap();
    assert!(matches!(store.update(&mut stale), Err(Error::Conflict(_))));
    assert!(Store::open(&dir.path().join("metadata.sqlite")).is_err());
    store.bind_identity("docker:one").unwrap();
    store.bind_identity("docker:one").unwrap();
    assert!(store.bind_identity("docker:two").is_err());
}
