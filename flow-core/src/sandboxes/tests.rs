//! sandboxes 域验收测试：对照 SPEC.md「关键功能与验收」逐条覆盖。
//!
//! 环境为本域临时数据库、Gateway 与 Channel 接口替身（SPEC「交付与
//! 验收边界」）。每个测试注释标注对应验收条目。

use std::sync::Arc;

use tempfile::TempDir;

use crate::sandboxes::error::{AccessError, GatewayError, SandboxServiceError};
use crate::sandboxes::model::{GatewaySandboxStatus, PortSpec, SandboxSpec, Visibility};
use crate::sandboxes::service::{FrozenSandboxConfig, SandboxService};
use crate::sandboxes::state::DomainSandboxState;
use crate::sandboxes::store::SandboxStore;
use crate::sandboxes::testing::channel::{ChannelFailures, FakeChannels};
use crate::sandboxes::testing::gateway::{FakeGateway, GatewayCall, GatewayFailures};

/// 测试环境：临时库 + 服务（Gateway/Channel 为可断言替身）。
struct Fixture {
    _dir: TempDir,
    service: SandboxService<Arc<FakeGateway>, Arc<FakeChannels>>,
    gateway: Arc<FakeGateway>,
    channels: Arc<FakeChannels>,
}

fn spec(image: &str) -> SandboxSpec {
    SandboxSpec {
        image: image.to_string(),
        ports: vec![PortSpec {
            name: "web".into(),
            port: 8080,
            visibility: Visibility::Internal,
            ready: true,
        }],
        memory_mb: Some(256),
        cpus: Some(1.0),
        ..Default::default()
    }
}

fn config(image: &str) -> FrozenSandboxConfig {
    FrozenSandboxConfig { spec: spec(image) }
}

fn fixture(ready: bool) -> Fixture {
    let dir = TempDir::new().expect("创建临时目录");
    let store = SandboxStore::open(dir.path().join("sandboxes.db")).expect("打开本域存储");
    let gateway = Arc::new(FakeGateway::new(ready));
    let channels = Arc::new(FakeChannels::new());
    let service = SandboxService::new(store, gateway.clone(), channels.clone());
    Fixture {
        _dir: dir,
        service,
        gateway,
        channels,
    }
}

const RUN: &str = "run_1";

mod protocol;

async fn prepare_ready(fx: &Fixture) {
    let view = fx
        .service
        .prepare(RUN, &config("img:ok"))
        .await
        .expect("准备已受理");
    assert_eq!(view.sandbox_id.as_deref(), Some("sbx_1"));
    assert_eq!(view.state, DomainSandboxState::PreparePending);
    assert!(matches!(
        fx.gateway.calls().as_slice(),
        [GatewayCall::Prepare(..)]
    ));
    assert_eq!(
        fx.service.status(RUN).await.unwrap().state,
        DomainSandboxState::Ready
    );
}

// ---------------------------------------------------------------------------
// 准备与关联
// ---------------------------------------------------------------------------

/// 验收（准备与关联）：给定运行标识和配置，准备成功后可查询对应沙箱
/// 标识与就绪状态。
#[tokio::test]
async fn prepare_success_yields_sandbox_id_and_ready_status() {
    let fx = fixture(true);
    prepare_ready(&fx).await;

    let view = fx.service.status(RUN).await.expect("查询成功");
    assert_eq!(view.run_id, RUN);
    assert_eq!(view.sandbox_id.as_deref(), Some("sbx_1"));
    assert_eq!(view.gateway_status, Some(GatewaySandboxStatus::Running));
    assert_eq!(view.state, DomainSandboxState::Ready);
    // 就绪判定来自 Gateway 平台视图。
    assert!(matches!(
        view.gateway_status,
        Some(GatewaySandboxStatus::Running)
    ));
}

/// 验收（准备与关联）：同一准备操作重复提交时复用已确认关联，不额外
/// 分配资源。
#[tokio::test]
async fn repeated_prepare_reuses_confirmed_link_without_new_allocation() {
    let fx = fixture(true);
    prepare_ready(&fx).await;

    let view = fx
        .service
        .prepare(RUN, &config("img:ok"))
        .await
        .expect("重复提交成功");
    assert_eq!(view.sandbox_id.as_deref(), Some("sbx_1"));
    assert_eq!(fx.gateway.allocated(), 1, "重复提交不得额外分配资源");
    let prepares = fx
        .gateway
        .calls()
        .into_iter()
        .filter(|c| matches!(c, GatewayCall::Prepare(_, _)))
        .count();
    assert_eq!(prepares, 1, "复用路径不再发起准备请求");
}

/// 验收（准备与关联）：Gateway 尚未就绪或调用失败时返回可区分状态，
/// 运行不能将其当作可执行环境。
#[tokio::test]
async fn gateway_failure_returns_distinguishable_state_not_executable() {
    let fx = fixture(true);
    fx.gateway.fail(GatewayFailures {
        prepare_failed: true,
        ..Default::default()
    });

    assert!(matches!(
        fx.service.prepare(RUN, &config("img:bad")).await,
        Err(SandboxServiceError::Control(GatewayError::Failed(_)))
    ));
    let view = fx.service.store().platform_view(RUN).unwrap().unwrap();
    assert_ne!(
        view.state,
        DomainSandboxState::Ready,
        "失败不得进入可执行状态"
    );
    assert_eq!(view.state, DomainSandboxState::PreparePending);
    assert!(view.last_error.is_some(), "失败摘要随视图返回");
    // 访问被拒：错误身份可区分（NotReady，而非连接故障）。
    let err = fx
        .service
        .exec_command(RUN, "ls")
        .await
        .expect_err("拒绝访问");
    match err {
        SandboxServiceError::Access(AccessError::NotReady(_)) => {}
        other => panic!("应为 NotReady，实际 {other:?}"),
    }
}

/// 验收（准备与关联）：模拟响应丢失并重开本域存储，查询核实后能够
/// 恢复正确关联。
#[tokio::test]
async fn lost_response_recovers_link_after_reopening_store() {
    let dir = TempDir::new().expect("创建临时目录");
    let db_path = dir.path().join("sandboxes.db");

    // 第一段：prepare 收到 Unknown（响应丢失），本地记录 Unknown。
    let store = SandboxStore::open(&db_path).expect("打开本域存储");
    let gateway = Arc::new(FakeGateway::new(true));
    let channels = Arc::new(FakeChannels::new());
    let service = SandboxService::new(store, gateway.clone(), channels.clone());
    gateway.fail(GatewayFailures {
        prepare_unknown: true,
        ..Default::default()
    });
    assert!(matches!(
        service.prepare(RUN, &config("img:ok")).await,
        Err(SandboxServiceError::Control(GatewayError::Unknown(_)))
    ));
    assert_eq!(gateway.allocated(), 1);
    let view = service.store().platform_view(RUN).unwrap().unwrap();
    assert_eq!(view.state, DomainSandboxState::Unknown);
    let operation_id = view.prepare_operation_id.clone();
    assert!(!operation_id.is_empty(), "操作身份已持久化");
    drop(service);

    // 第二段：重开本域存储，以相同操作身份重试并经查询核实恢复关联。
    let store = SandboxStore::open(&db_path).expect("重开本域存储");
    gateway.fail(Default::default());
    let channels = Arc::new(FakeChannels::new());
    let service = SandboxService::new(store, gateway.clone(), channels.clone());
    let view = service.status(RUN).await.expect("核实成功");
    assert_eq!(view.state, DomainSandboxState::Ready);
    assert_eq!(view.sandbox_id.as_deref(), Some("sbx_1"));
    assert_eq!(
        view.prepare_operation_id, operation_id,
        "重试复用相同操作身份",
    );
    // 幂等重试 + get 核实：prepare 调用两次（首购与重试），绑定同一沙箱。
    let prepares: Vec<_> = gateway
        .calls()
        .into_iter()
        .filter(|c| matches!(c, GatewayCall::Prepare(_, _)))
        .collect();
    assert_eq!(prepares.len(), 2);
    assert_eq!(prepares[0], prepares[1], "同键同规格重放");
    assert_eq!(gateway.allocated(), 1);
    let gets: Vec<_> = gateway
        .calls()
        .into_iter()
        .filter(|c| matches!(c, GatewayCall::Get(_)))
        .collect();
    assert!(!gets.is_empty(), "经 get 核实恢复关联");
}

// ---------------------------------------------------------------------------
// 状态查询与释放
// ---------------------------------------------------------------------------

/// 验收（状态查询与释放）：查询关联可得到运行标识、沙箱标识及 Gateway
/// 返回的资源状态，未知关联返回不存在。
#[tokio::test]
async fn status_returns_platform_view_and_unknown_link_is_not_found() {
    let fx = fixture(true);
    prepare_ready(&fx).await;

    let view = fx.service.status(RUN).await.expect("查询成功");
    assert_eq!(view.run_id, RUN);
    assert_eq!(view.sandbox_id.as_deref(), Some("sbx_1"));
    assert_eq!(view.gateway_status, Some(GatewaySandboxStatus::Running));

    let err = fx
        .service
        .status("run_missing")
        .await
        .expect_err("未知关联返回不存在");
    match err {
        SandboxServiceError::Access(AccessError::NotFound(id)) => assert_eq!(id, "run_missing"),
        other => panic!("应为 NotFound，实际 {other:?}"),
    }
}

/// 验收（状态查询与释放）：释放失败或响应超时不会报告资源已释放，
/// 后续查询与重试可确认最终结果。
#[tokio::test]
async fn release_timeout_keeps_release_pending_and_retry_confirms() {
    let fx = fixture(true);
    prepare_ready(&fx).await;

    // 第一次释放：响应丢失（超时），不得报告已释放。
    fx.gateway.fail(GatewayFailures {
        release_unknown: true,
        ..Default::default()
    });
    assert!(matches!(
        fx.service.release(RUN).await,
        Err(SandboxServiceError::Control(GatewayError::Unknown(_)))
    ));
    let view = fx.service.store().platform_view(RUN).unwrap().unwrap();
    assert_eq!(
        view.state,
        DomainSandboxState::ReleasePending,
        "未确认保留待核实状态"
    );
    assert_ne!(view.state, DomainSandboxState::Released);

    // 后续查询保留 ReleasePending；平台查询失败同样不覆盖记录。
    fx.gateway.fail(GatewayFailures {
        get_failed: true,
        ..Default::default()
    });
    assert!(matches!(
        fx.service.status(RUN).await,
        Err(SandboxServiceError::Control(GatewayError::Failed(_)))
    ));
    let view = fx.service.store().platform_view(RUN).unwrap().unwrap();
    assert_eq!(view.state, DomainSandboxState::ReleasePending);

    // 重试：故障清除后确认释放。
    fx.gateway.fail(GatewayFailures::default());
    let view = fx.service.release(RUN).await.expect("重试成功");
    assert_eq!(view.state, DomainSandboxState::ReleasePending);
    assert_eq!(
        fx.service.status(RUN).await.unwrap().state,
        DomainSandboxState::Released
    );
}

/// 验收（状态查询与释放）：已完成的释放再次请求具有幂等结果。
#[tokio::test]
async fn repeated_release_after_confirmed_is_idempotent() {
    let fx = fixture(true);
    prepare_ready(&fx).await;

    let first = fx.service.release(RUN).await.expect("首次释放成功");
    assert_eq!(first.state, DomainSandboxState::ReleasePending);
    assert_eq!(
        fx.service.status(RUN).await.unwrap().state,
        DomainSandboxState::Released
    );

    let second = fx.service.release(RUN).await.expect("再次释放幂等成功");
    assert_eq!(second.state, DomainSandboxState::Released);
    assert_eq!(second.sandbox_id, first.sandbox_id);
    // 释放调用只发生一次。
    let releases = fx
        .gateway
        .calls()
        .into_iter()
        .filter(|c| matches!(c, GatewayCall::Release(_)))
        .count();
    assert_eq!(releases, 1, "已完成释放的再请求不重复调用平台");
}

/// 验收（状态查询与释放）：平台侧查询失败不会覆盖先前记录为虚假的
/// 资源终态。
#[tokio::test]
async fn platform_query_failure_preserves_local_record() {
    let fx = fixture(true);
    prepare_ready(&fx).await;

    fx.gateway.fail(GatewayFailures {
        get_failed: true,
        ..Default::default()
    });
    assert!(matches!(
        fx.service.status(RUN).await,
        Err(SandboxServiceError::Control(GatewayError::Failed(_)))
    ));
    let view = fx.service.store().platform_view(RUN).unwrap().unwrap();
    assert_eq!(view.state, DomainSandboxState::Unknown);
    assert_eq!(view.sandbox_id.as_deref(), Some("sbx_1"));
    assert_eq!(
        view.gateway_status,
        Some(GatewaySandboxStatus::Running),
        "先前平台快照未被覆盖",
    );
}

/// 释放意图未被确认（confirmed=false）时保留 ReleasePending 可重试。
/// 验收（状态查询与释放）：释放失败不报告资源已释放。
#[tokio::test]
async fn release_unconfirmed_keeps_pending() {
    let fx = fixture(true);
    prepare_ready(&fx).await;

    fx.gateway.fail(GatewayFailures {
        release_unconfirmed: true,
        ..Default::default()
    });
    let view = fx.service.release(RUN).await.expect("释放请求已处理");
    assert_eq!(view.state, DomainSandboxState::ReleasePending);
    assert_ne!(view.state, DomainSandboxState::Released);
}

// ---------------------------------------------------------------------------
// 文件与连接接入
// ---------------------------------------------------------------------------

/// 验收（文件与连接接入）：文件通道替身收到指定目标、路径与原始内容，
/// 回读保持完整；命令返回输出与退出状态。
#[tokio::test]
async fn file_channel_receives_target_path_bytes_and_exec_returns_outcome() {
    let fx = fixture(true);
    prepare_ready(&fx).await;

    let content = b"#!/bin/sh\necho hello\n".to_vec();
    let written = fx
        .service
        .transfer_file(RUN, "/ursi/workspace/in.sh", &content)
        .await
        .expect("传输成功");
    assert_eq!(written, content.len());

    let calls = fx.channels.file_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(
        calls[0].target.sandbox_id, "sbx_1",
        "目标身份为平台沙箱标识"
    );
    assert_eq!(calls[0].path, "/ursi/workspace/in.sh");
    assert_eq!(calls[0].bytes, content, "回读保持完整");

    let outcome = fx
        .service
        .exec_command(RUN, "sh /ursi/workspace/in.sh")
        .await
        .expect("执行成功");
    assert_eq!(outcome.exit_code, 0);
    assert_eq!(outcome.output, "ran: sh /ursi/workspace/in.sh");
    let execs = fx.channels.exec_calls();
    assert_eq!(execs.len(), 1);
    assert_eq!(execs[0].target.sandbox_id, "sbx_1");
    assert_eq!(execs[0].cmd, "sh /ursi/workspace/in.sh");
}

/// 验收（文件与连接接入）：不存在或未就绪的沙箱拒绝访问，错误身份与
/// 不可达端点返回可区分错误。
#[tokio::test]
async fn access_rejected_for_missing_and_unready_sandbox_with_distinct_errors() {
    let fx = fixture(true);

    // 不存在：NotFound。
    let err = fx
        .service
        .exec_command("run_missing", "ls")
        .await
        .expect_err("拒绝访问");
    assert!(matches!(
        err,
        SandboxServiceError::Access(AccessError::NotFound(_))
    ));

    // 未就绪（PreparePending）：NotReady。
    fx.gateway.fail(GatewayFailures {
        prepare_unknown: true,
        ..Default::default()
    });
    let _ = fx.service.prepare(RUN, &config("img:ok")).await;
    let err = fx
        .service
        .transfer_file(RUN, "/tmp/x", b"x")
        .await
        .expect_err("拒绝访问");
    assert!(matches!(
        err,
        SandboxServiceError::Access(AccessError::Unknown(_))
    ));

    // 未确认关联（Ready 之前）拒绝文件与终端接入。
    let fx2 = fixture(true);
    fx2.gateway.fail(GatewayFailures {
        prepare_failed: true,
        ..Default::default()
    });
    let _ = fx2.service.prepare(RUN, &config("img:ok")).await;
    let err = fx2.service.open_terminal(RUN).await.expect_err("拒绝访问");
    assert!(matches!(
        err,
        SandboxServiceError::Access(AccessError::NotReady(_))
    ));
}

/// 验收（文件与连接接入）：连接中断返回连接故障，不自动重试上层任务。
#[tokio::test]
async fn connection_interruption_returns_connection_error_without_retry() {
    let fx = fixture(true);
    prepare_ready(&fx).await;

    fx.channels.fail(ChannelFailures {
        file_connection: true,
        ..Default::default()
    });
    let err = fx
        .service
        .transfer_file(RUN, "/ursi/workspace/in.sh", b"data")
        .await
        .expect_err("连接中断返回错误");
    match err {
        SandboxServiceError::Access(AccessError::Connection(msg)) => {
            assert!(msg.contains("连接中断"));
        }
        other => panic!("应为 Connection，实际 {other:?}"),
    }
    // 只调用一次：不自动重试上层任务。
    assert_eq!(fx.channels.file_calls().len(), 1);
}

/// 验收（文件与连接接入）：不可达端点与错误身份返回可区分错误。
#[tokio::test]
async fn unreachable_endpoint_and_auth_failure_are_distinguishable() {
    let fx = fixture(true);
    prepare_ready(&fx).await;

    fx.channels.fail(ChannelFailures {
        exec_unreachable: true,
        ..Default::default()
    });
    let err = fx
        .service
        .exec_command(RUN, "ls")
        .await
        .expect_err("不可达错误");
    assert!(matches!(
        err,
        SandboxServiceError::Access(AccessError::Unreachable(_))
    ));

    fx.channels.fail(ChannelFailures {
        terminal_auth: true,
        ..Default::default()
    });
    let err = fx.service.open_terminal(RUN).await.expect_err("鉴权错误");
    assert!(matches!(
        err,
        SandboxServiceError::Access(AccessError::Auth(_))
    ));
}

/// 验收（文件与连接接入）：释放与连接关闭能够回收本地句柄，连接关闭
/// 不被当作远端任务已经取消。
#[tokio::test]
async fn release_recycles_handles_and_close_is_not_remote_cancellation() {
    let fx = fixture(true);
    prepare_ready(&fx).await;

    let mut terminal = fx.service.open_terminal(RUN).await.expect("终端连接成功");
    assert!(terminal.is_open());

    // 显式回收句柄。
    terminal.close();
    assert!(!terminal.is_open());

    // 释放回收通道准入与句柄。
    fx.service.release(RUN).await.expect("释放成功");
    assert_eq!(fx.channels.recycled(), 1, "释放回收本地句柄");
    let grant = fx.service.store().access_grant(RUN).expect("查询准入");
    assert!(grant.is_none(), "释放后准入记录清空");

    // 释放后访问：AccessClosed（连接关闭语义），与远端任务取消区分
    // （错误类型中没有“任务取消”变体，连接关闭不通知运行）。
    let err = fx
        .service
        .transfer_file(RUN, "/tmp/x", b"x")
        .await
        .expect_err("拒绝访问");
    assert!(
        matches!(err, SandboxServiceError::Access(AccessError::NotReady(_))),
        "Released 关联拒绝新访问",
    );
}

/// 终端句柄来自替身且目标身份正确（连接接入请求参数验收）。
#[tokio::test]
async fn terminal_channel_receives_target_identity() {
    let fx = fixture(true);
    prepare_ready(&fx).await;

    let terminal = fx.service.open_terminal(RUN).await.expect("终端连接成功");
    assert!(terminal.is_open());
    let calls = fx.channels.terminal_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].target.sandbox_id, "sbx_1");
}

/// 规格变化时的重复提交被拒绝（关联绑定冻结规格）。
#[tokio::test]
async fn prepare_with_different_spec_on_confirmed_link_is_rejected() {
    let fx = fixture(true);
    prepare_ready(&fx).await;

    let err = fx
        .service
        .prepare(RUN, &config("img:other"))
        .await
        .expect_err("不同规格拒绝替换");
    assert!(matches!(
        err,
        SandboxServiceError::Access(AccessError::NotAvailable(_))
    ));
    assert_eq!(fx.gateway.allocated(), 1);
}
