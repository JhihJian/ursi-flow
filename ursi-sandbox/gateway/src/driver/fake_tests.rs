use super::*;
use crate::models::{Endpoint, EndpointState, SandboxSpec, Status};

fn sandbox(generation: u64, data_generation: u64) -> Sandbox {
    Sandbox {
        id: "test".into(),
        spec: SandboxSpec {
            image: "test:latest".into(),
            command: vec![],
            labels: Default::default(),
            memory_mb: 256,
            cpus: 1.0,
            bundle: None,
            runtime_profile: None,
        },
        resource: Resource {
            generation,
            data_generation,
        },
        status: Status::Preparing,
        operation: None,
        retired: vec![],
        revision: 1,
        endpoints: vec![],
        error: None,
    }
}

#[tokio::test]
async fn lifecycle_reports_actual_state_and_tail() {
    let driver = FakeDriver::new();
    let sandbox = sandbox(1, 1);
    let observed = driver.ensure(&sandbox).await.unwrap();
    assert!(observed.running);
    assert!(observed.endpoints.is_empty());
    assert_eq!(observed.healthy, None);
    driver.ensure(&sandbox).await.unwrap();
    assert_eq!(driver.inner.lock().unwrap().resources.len(), 1);
    driver.stop(&sandbox).await.unwrap();
    assert!(!driver.observe(&sandbox).await.unwrap().running);
    driver.start(&sandbox).await.unwrap();
    assert_eq!(driver.logs(&sandbox, 2).await.unwrap(), "stopped\nstarted");
    assert_eq!(driver.logs(&sandbox, 0).await.unwrap(), "");
    driver
        .remove(&sandbox.id, sandbox.resource, true)
        .await
        .unwrap();
    driver
        .remove(&sandbox.id, sandbox.resource, true)
        .await
        .unwrap();
    assert!(matches!(
        driver.observe(&sandbox).await,
        Err(Error::NotFound(_))
    ));
}

#[tokio::test]
async fn generations_are_isolated_and_preserved_volume_is_reused() {
    let driver = FakeDriver::default();
    let old = sandbox(1, 1);
    let new = sandbox(2, 1);
    driver.ensure(&old).await.unwrap();
    driver.ensure(&new).await.unwrap();
    assert!(matches!(
        driver.remove(&old.id, old.resource, true).await,
        Err(Error::Conflict(_))
    ));
    driver.remove(&old.id, old.resource, false).await.unwrap();
    assert!(driver.observe(&new).await.unwrap().running);
    assert_eq!(driver.inner.lock().unwrap().volumes.len(), 1);
    driver.remove(&new.id, new.resource, true).await.unwrap();
    assert!(driver.inner.lock().unwrap().volumes.is_empty());
    let replacement = sandbox(3, 3);
    driver.ensure(&replacement).await.unwrap();
    let wrong = sandbox(3, 1);
    assert!(matches!(
        driver.observe(&wrong).await,
        Err(Error::Conflict(_))
    ));
    assert!(matches!(
        driver.remove(&wrong.id, wrong.resource, true).await,
        Err(Error::Conflict(_))
    ));
}

#[tokio::test]
async fn every_operation_can_fail_once_without_losing_resources() {
    let driver = FakeDriver::new();
    let sandbox = sandbox(1, 1);
    for operation in ["create", "ensure"] {
        driver.fail_next(operation);
        assert!(matches!(
            driver.ensure(&sandbox).await,
            Err(Error::Unavailable(_))
        ));
    }
    driver.ensure(&sandbox).await.unwrap();
    driver.fail_next("start");
    assert!(matches!(
        driver.start(&sandbox).await,
        Err(Error::Unavailable(_))
    ));
    driver.start(&sandbox).await.unwrap();
    driver.fail_next("stop");
    assert!(matches!(
        driver.stop(&sandbox).await,
        Err(Error::Unavailable(_))
    ));
    assert!(driver.observe(&sandbox).await.unwrap().running);
    driver.stop(&sandbox).await.unwrap();
    driver.fail_next("observe");
    assert!(matches!(
        driver.observe(&sandbox).await,
        Err(Error::Unavailable(_))
    ));
    assert!(!driver.observe(&sandbox).await.unwrap().running);
    driver.fail_next("logs");
    assert!(matches!(
        driver.logs(&sandbox, 10).await,
        Err(Error::Unavailable(_))
    ));
    assert!(!driver.logs(&sandbox, 10).await.unwrap().is_empty());
    driver.fail_next("remove");
    assert!(matches!(
        driver.remove(&sandbox.id, sandbox.resource, true).await,
        Err(Error::Unavailable(_))
    ));
    assert!(!driver.observe(&sandbox).await.unwrap().running);
    driver
        .remove(&sandbox.id, sandbox.resource, true)
        .await
        .unwrap();
}

#[tokio::test]
async fn partial_creates_recover_and_stopped_resources_hide_endpoints() {
    for point in ["ensure_after_volume", "ensure_after_create"] {
        let driver = FakeDriver::new();
        let mut sandbox = sandbox(1, 1);
        sandbox.endpoints.push(Endpoint {
            name: "ssh".into(),
            bundle: "terminal".into(),
            protocol: "ssh".into(),
            port: 22,
            state: EndpointState::Declared,
            ready: false,
        });
        driver.fail_next(point);
        assert!(matches!(
            driver.ensure(&sandbox).await,
            Err(Error::Unavailable(_))
        ));
        assert_eq!(driver.inner.lock().unwrap().volumes.len(), 1);
        assert_eq!(
            driver.ensure(&sandbox).await.unwrap().endpoints[0].address,
            "127.0.0.1:22"
        );
        assert_eq!(driver.inner.lock().unwrap().resources.len(), 1);
        driver.stop(&sandbox).await.unwrap();
        assert!(driver.observe(&sandbox).await.unwrap().endpoints.is_empty());
    }
}
