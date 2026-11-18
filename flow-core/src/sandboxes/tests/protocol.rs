use super::*;
use crate::sandboxes::{GatewayClient, GatewaySandboxView, PrepareReceipt, ReleaseReceipt};
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::Notify;

/// 第一份回包可精确暂停在远端已分配、本地还不知道 ID 的窗口。
struct PauseFirstReceipt {
    gateway: Arc<FakeGateway>,
    paused: AtomicBool,
    resume: Notify,
}

#[async_trait::async_trait]
impl GatewayClient for PauseFirstReceipt {
    async fn prepare(&self, key: &str, spec: &SandboxSpec) -> Result<PrepareReceipt, GatewayError> {
        let receipt = self.gateway.prepare(key, spec).await?;
        if !self.paused.swap(true, Ordering::SeqCst) {
            self.resume.notified().await;
        }
        Ok(receipt)
    }
    async fn get(&self, id: &str) -> Result<GatewaySandboxView, GatewayError> {
        self.gateway.get(id).await
    }
    async fn release(&self, id: &str) -> Result<ReleaseReceipt, GatewayError> {
        self.gateway.release(id).await
    }
}

#[tokio::test]
async fn concurrent_prepares_use_persisted_identity_and_late_receipt_cannot_revive_release() {
    let dir = TempDir::new().unwrap();
    let db = dir.path().join("links.db");
    let remote = Arc::new(FakeGateway::new(true));
    let port = Arc::new(PauseFirstReceipt {
        gateway: remote.clone(),
        paused: false.into(),
        resume: Notify::new(),
    });
    let connect = || {
        SandboxService::new(
            SandboxStore::open(&db).unwrap(),
            port.clone(),
            Arc::new(FakeChannels::new()),
        )
    };
    let first = connect();
    let cfg = config("img:ok");
    let mut pending = Box::pin(first.prepare(RUN, &cfg));
    assert!(futures_util::poll!(&mut pending).is_pending());
    assert_eq!(remote.allocated(), 1);

    let second = connect();
    let saved = second.store().request_record(RUN).unwrap().unwrap();
    assert!(saved.sandbox_id.is_none());
    assert_eq!(
        serde_json::from_str::<SandboxSpec>(&saved.spec_json).unwrap(),
        cfg.spec
    );
    assert!(matches!(
        second.prepare(RUN, &config("img:other")).await,
        Err(SandboxServiceError::Access(AccessError::NotAvailable(_)))
    ));
    assert_eq!(
        second.prepare(RUN, &cfg).await.unwrap().state,
        DomainSandboxState::PreparePending
    );
    assert_eq!(
        second.release(RUN).await.unwrap().state,
        DomainSandboxState::ReleasePending
    );
    assert_eq!(
        second.status(RUN).await.unwrap().state,
        DomainSandboxState::Released
    );
    port.resume.notify_one();
    assert_eq!(pending.await.unwrap().state, DomainSandboxState::Released);
    let posts: Vec<_> = remote
        .calls()
        .into_iter()
        .filter_map(|call| match call {
            GatewayCall::Prepare(key, spec) => Some((key, spec)),
            _ => None,
        })
        .collect();
    assert_eq!(
        posts,
        vec![(saved.prepare_operation_id, saved.spec_json); 2]
    );
    assert_eq!(remote.allocated(), 1);
}

#[tokio::test]
async fn release_can_recover_lost_create_receipt_by_original_key() {
    let fx = fixture(true);
    fx.gateway.fail(GatewayFailures {
        prepare_unknown: true,
        ..Default::default()
    });
    assert!(fx.service.prepare(RUN, &config("img:ok")).await.is_err());
    fx.gateway.fail(Default::default());
    let pending = fx.service.release(RUN).await.unwrap();
    assert_eq!(pending.state, DomainSandboxState::ReleasePending);
    assert_eq!(pending.sandbox_id.as_deref(), Some("sbx_1"));
    assert_eq!(
        fx.service.release(RUN).await.unwrap().state,
        DomainSandboxState::Released
    );
    assert_eq!(fx.gateway.allocated(), 1);
}

#[tokio::test]
async fn only_matching_idle_running_observation_allows_channel_access() {
    let fx = fixture(false);
    assert_eq!(
        fx.service
            .prepare(RUN, &config("img:ok"))
            .await
            .unwrap()
            .state,
        DomainSandboxState::PreparePending
    );
    assert!(fx.service.transfer_file(RUN, "/in", b"x").await.is_err());
    fx.gateway.set_running("sbx_1");
    assert_eq!(
        fx.service.status(RUN).await.unwrap().state,
        DomainSandboxState::Ready
    );

    fx.gateway.fail(GatewayFailures {
        operation_pending: true,
        ..Default::default()
    });
    assert!(matches!(
        fx.service.exec_command(RUN, "true").await,
        Err(SandboxServiceError::Access(AccessError::NotReady(_)))
    ));
    fx.gateway.fail(GatewayFailures {
        wrong_id: true,
        ..Default::default()
    });
    assert!(matches!(
        fx.service.transfer_file(RUN, "/in", b"x").await,
        Err(SandboxServiceError::Control(GatewayError::Protocol(_)))
    ));
    fx.gateway.fail(GatewayFailures {
        get_unknown: true,
        ..Default::default()
    });
    assert!(matches!(
        fx.service.open_terminal(RUN).await,
        Err(SandboxServiceError::Control(GatewayError::Unknown(_)))
    ));
    assert!(
        fx.channels.file_calls().is_empty()
            && fx.channels.exec_calls().is_empty()
            && fx.channels.terminal_calls().is_empty()
    );
}

#[tokio::test]
async fn ordinary_not_found_is_not_release_confirmation() {
    let fx = fixture(true);
    prepare_ready(&fx).await;
    fx.gateway.remove("sbx_1");
    assert!(matches!(
        fx.service.status(RUN).await,
        Err(SandboxServiceError::Control(GatewayError::NotFound(_)))
    ));
    let saved = fx.service.store().platform_view(RUN).unwrap().unwrap();
    assert_eq!(saved.state, DomainSandboxState::Unknown);
    assert_eq!(saved.sandbox_id.as_deref(), Some("sbx_1"));
    assert_eq!(saved.gateway_status, Some(GatewaySandboxStatus::Running));
    assert_eq!(
        fx.service.release(RUN).await.unwrap().state,
        DomainSandboxState::Released
    );
}
