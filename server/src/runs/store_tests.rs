//! 存储层验收测试：代数 CAS、事务原子性、事件游标与可控时钟租约。
//!
//! SPEC 条目（runs/SPEC.md）：
//! - 「运行创建与配置冻结」：创建后可读回与创建时一致的完整快照。
//! - 「状态提交、租约与取消」：过期代数提交被拒；注入事务失败状态与事件
//!   均不提交；可控时钟模拟租约到期，重开存储后可接管。
//! - 「查询、事件与资源收尾」：事件按游标顺序重放；无订阅方时已提交事件
//!   仍可从存储读回。

use std::sync::Arc;

use ursi_domain::{NodeStatus, RunStatus};

use super::store::SqliteRunStore;
use super::testing::{FakeClock, chain_workflow, initial_run, node};
use super::{CleanupState, FrozenRoles, LeaseError, LeaseTable, RunRepository};

const HOLDER_A: &str = "engine-a";
const HOLDER_B: &str = "engine-b";
const TTL_MS: u64 = 1_000;

fn open_store(clock: Arc<FakeClock>) -> (tempfile::TempDir, SqliteRunStore) {
    let dir = tempfile::tempdir().expect("创建临时目录");
    let store = SqliteRunStore::open(dir.path().join("runs.db"), clock).expect("打开存储");
    (dir, store)
}

fn open_store_at(clock_ms: i64) -> (Arc<FakeClock>, tempfile::TempDir, SqliteRunStore) {
    let clock = FakeClock::start_at(clock_ms);
    let dir = tempfile::tempdir().expect("创建临时目录");
    let store = SqliteRunStore::open(dir.path().join("runs.db"), clock.clone()).expect("打开存储");
    (clock, dir, store)
}

fn event(msg: &str) -> ursi_domain::TelemetryEvent {
    ursi_domain::TelemetryEvent {
        category: ursi_domain::EventCategory::Node,
        name: "test".to_string(),
        phase: ursi_domain::EventPhase::Progress,
        message: msg.to_string(),
        attributes: Default::default(),
    }
}

fn empty_roles() -> FrozenRoles {
    serde_json::Map::new()
}

/// SPEC「运行创建与配置冻结」：创建 queued 运行，可读回与创建时一致的
/// 完整快照与初始节点状态。
#[tokio::test]
async fn create_then_read_back_roundtrip() {
    let clock = FakeClock::start_at(1_000);
    let (_dir, store) = open_store(clock);
    let wf = chain_workflow();
    let run = initial_run(&wf);
    store.create_run(&run, &empty_roles()).await.expect("创建运行");

    let loaded = store.get_run(&run.id).await.expect("读取运行").expect("运行存在");
    assert_eq!(loaded.status, RunStatus::Queued);
    assert_eq!(loaded.generation, 1);
    assert_eq!(loaded.nodes.len(), 3);
    for n in &loaded.nodes {
        assert_eq!(n.status, NodeStatus::Pending);
        assert_eq!(n.attempts, 0);
        assert_eq!(n.reworks, 0);
    }
    assert_eq!(
        serde_json::to_string(&loaded.workflow).unwrap(),
        serde_json::to_string(&wf).unwrap(),
        "快照读回与创建时一致"
    );
    // 未知 id 返回 None。
    assert!(store.get_run("no-such-run").await.expect("读取不存在运行").is_none());
}

/// SPEC「查询、事件与资源收尾」：提交后事件按 seq 有序读回，无订阅方
/// （未使用 EventBus）时事件仍入库；游标补读只返回增量。
#[tokio::test]
async fn commit_events_then_cursor_readback() {
    let clock = FakeClock::start_at(1_000);
    let (_dir, store) = open_store(clock);
    let wf = chain_workflow();
    let run = initial_run(&wf);
    store.create_run(&run, &empty_roles()).await.expect("创建运行");
    let run_id = run.id.clone();

    let mut run = store.get_run(&run_id).await.expect("读取").unwrap();
    run.status = RunStatus::Running;
    store
        .commit_run(&run, 1, &[event("一"), event("二")])
        .await
        .expect("提交");

    let mut run = store.get_run(&run_id).await.expect("读取").unwrap();
    run.status = RunStatus::Succeeded;
    // 同代数内可连续提交（代数只在租约 acquire/接管时递增）。
    store.commit_run(&run, 1, &[event("三")]).await.expect("提交");

    let all = store.list_events(&run_id).await.expect("读取事件");
    assert_eq!(all.len(), 3);
    assert_eq!(
        all.iter().map(|r| r.seq).collect::<Vec<_>>(),
        vec![1, 2, 3],
        "seq 提交时确定且单调递增"
    );
    assert_eq!(all[2].event.message, "三");

    // 游标补读：after_seq=1 只返回 2、3。
    let since = store.list_events_since(&run_id, 1).await.expect("游标读取");
    assert_eq!(since.iter().map(|r| r.seq).collect::<Vec<_>>(), vec![2, 3]);
    // 超前游标返回空。
    assert!(store.list_events_since(&run_id, 99).await.expect("游标读取").is_empty());
    // 未知运行返回空列表。
    assert!(store.list_events("no-such").await.expect("读取").is_empty());
}

/// SPEC「状态提交、租约与取消」+「审批、重试与返工」：过期代数提交被拒
/// 且当前结果不被覆盖（CAS 语义），被拒提交的事件不入库。
#[tokio::test]
async fn stale_generation_commit_rejected_and_not_overwritten() {
    let clock = FakeClock::start_at(1_000);
    let (_dir, store) = open_store(clock);
    let wf = chain_workflow();
    let run = initial_run(&wf);
    store.create_run(&run, &empty_roles()).await.expect("创建运行");
    let run_id = run.id.clone();

    // 持有者 A 取得代数 2 并提交 succeeded。
    let gen_a = store.acquire_lease(&run_id, HOLDER_A, TTL_MS).await.expect("A 取得租约");
    assert_eq!(gen_a, 2);
    let mut run_a = store.get_run(&run_id).await.expect("读取").unwrap();
    run_a.status = RunStatus::Succeeded;
    store.commit_run(&run_a, gen_a, &[event("A 完成")]).await.expect("A 提交");

    // 过期提交：仍以旧代数 1 提交 failed，被 CAS 拒绝。
    let mut stale = store.get_run(&run_id).await.expect("读取").unwrap();
    stale.status = RunStatus::Failed;
    let err = store
        .commit_run(&stale, 1, &[event("过期提交")])
        .await
        .expect_err("过期提交必须被拒");
    assert!(matches!(err, crate::storage::StoreError::StaleGeneration(_)));
    // 拒绝的事件未落库。
    let all = store.list_events(&run_id).await.expect("读取事件");
    assert_eq!(all.len(), 1, "被拒提交的事件不得入库");
    assert_eq!(all[0].event.message, "A 完成");

    // 当前结果未被覆盖：仍是 succeeded。
    let run = store.get_run(&run_id).await.expect("读取").unwrap();
    assert_eq!(run.status, RunStatus::Succeeded);
}

/// SPEC「状态提交、租约与取消」：注入事务失败，状态和事件均不提交。
/// 失败注入：临时关闭外键约束后把运行主键改指向不存在的行，使 commit_run
/// 的 CAS 更新命中 0 行（StaleGeneration 同样走整体回滚路径）；节点行与
/// 事件都不得残留。
#[tokio::test]
async fn transaction_failure_rolls_back_state_and_events() {
    let clock = FakeClock::start_at(1_000);
    let (_dir, store) = open_store(clock);
    let wf = chain_workflow();
    let run = initial_run(&wf);
    store.create_run(&run, &empty_roles()).await.expect("创建运行");
    let run_id = run.id.clone();

    // 注入故障：篡改存储层主键（模拟存储层不一致），任何带该 run_id 的
    // 提交都会命中 0 行并被 CAS 拒绝。
    store
        .test_exec("PRAGMA foreign_keys = OFF")
        .expect("临时关外键");
    store
        .test_exec(&format!("UPDATE runs SET id = 'ghost-run' WHERE id = '{run_id}'"))
        .expect("篡改主键");
    store.test_exec("PRAGMA foreign_keys = ON").expect("恢复外键");

    // 先读一份干净副本再以被拒内容提交：篡改后 get_run 返回 None。
    let mut dirty = initial_run(&wf);
    dirty.id = run_id.clone();
    dirty.status = RunStatus::Running;
    let err = store
        .commit_run(&dirty, 1, &[event("不应入库")])
        .await
        .expect_err("注入失败必须让提交失败");
    assert!(
        matches!(err, crate::storage::StoreError::StaleGeneration(_)),
        "实际：{err:?}"
    );

    // 回滚验证：数据库内无该 run_id 的节点行与事件残留，篡改后的行原样。
    store
        .test_exec("PRAGMA foreign_keys = OFF")
        .expect("临时关外键");
    store
        .test_exec(&format!("UPDATE runs SET id = '{run_id}' WHERE id = 'ghost-run'"))
        .expect("还原主键");
    store.test_exec("PRAGMA foreign_keys = ON").expect("恢复外键");

    let after = store.get_run(&run_id).await.expect("读取").unwrap();
    assert_eq!(after.status, RunStatus::Queued, "状态未提交");
    assert_eq!(after.nodes.len(), 3);
    assert!(store.list_events(&run_id).await.expect("读取事件").is_empty());
}

/// SPEC「状态提交、租约与取消」：可控时钟模拟租约到期——持有期内他人
/// 不能获取；持有期内续约延长到期；到期后另一 holder 可接管且代数递增；
/// 旧持有者的提交因代数过期被拒。
#[tokio::test]
async fn lease_expiry_takeover_and_renewal() {
    let clock = FakeClock::start_at(10_000);
    let (_dir, store) = open_store(clock.clone());
    let wf = chain_workflow();
    let run = initial_run(&wf);
    store.create_run(&run, &empty_roles()).await.expect("创建运行");
    let run_id = run.id.clone();

    // A 获取租约（代数 2）。
    let gen_a = store.acquire_lease(&run_id, HOLDER_A, TTL_MS).await.expect("A 获取");
    assert_eq!(gen_a, 2);

    // 持有期内 B 不能获取。
    let err = store
        .acquire_lease(&run_id, HOLDER_B, TTL_MS)
        .await
        .expect_err("持有期内不可获取");
    assert!(matches!(err, LeaseError::Held { holder, .. } if holder == HOLDER_A));

    // A 持有期内续约成功，到期时间被延长。
    clock.advance(600);
    store.renew_lease(&run_id, HOLDER_A, TTL_MS).await.expect("续约");
    let lease = store.check_lease(&run_id).await.expect("查询租约").expect("有租约");
    assert_eq!(lease.holder, HOLDER_A);
    assert_eq!(lease.expires_at_ms, 10_600 + TTL_MS as i64);
    assert!(!lease.expired);

    // 未到期：B 仍不能获取。
    clock.advance(300);
    assert!(matches!(
        store.acquire_lease(&run_id, HOLDER_B, TTL_MS).await,
        Err(LeaseError::Held { .. })
    ));

    // 推进到租约到期（续约后到期时间为 10600+1000=11600，当前 10900）：
    // 再推 701ms 到 11601，B 可接管，代数递增为 3。
    clock.advance(701);
    let gen_b = store.acquire_lease(&run_id, HOLDER_B, TTL_MS).await.expect("B 接管");
    assert_eq!(gen_b, 3, "接管使持有代数递增");
    let lease = store.check_lease(&run_id).await.expect("查询").expect("有租约");
    assert_eq!(lease.holder, HOLDER_B);

    // 旧持有者 A 的过期提交被 CAS 拒绝（旧代数 2 < 当前 3）。
    let mut stale = store.get_run(&run_id).await.expect("读取").unwrap();
    stale.status = RunStatus::Failed;
    assert!(matches!(
        store.commit_run(&stale, gen_a, &[event("A 迟到")]).await,
        Err(crate::storage::StoreError::StaleGeneration(_))
    ));

    // B 租约到期后 A 接管（代数 4），被接管方续约被拒。
    clock.advance(TTL_MS as i64 + 1);
    let gen_c = store.acquire_lease(&run_id, HOLDER_A, TTL_MS).await.expect("A 再接管");
    assert_eq!(gen_c, 4);
    let err = store
        .renew_lease(&run_id, HOLDER_B, TTL_MS)
        .await
        .expect_err("B 租约已被接管");
    assert!(matches!(err, LeaseError::Held { holder, .. } if holder == HOLDER_A));

    // 清除租约后 check 返回 None。
    store
        .test_exec("UPDATE runs SET holder = NULL, lease_expires_at_ms = NULL")
        .expect("清除租约");
    assert!(store.check_lease(&run_id).await.expect("查询").is_none());
}

/// SPEC「状态提交、租约与取消」：租约操作对未知运行返回 NotFound。
#[tokio::test]
async fn lease_on_missing_run_is_not_found() {
    let clock = FakeClock::start_at(0);
    let (_dir, store) = open_store(clock);
    assert!(matches!(
        store.acquire_lease("ghost", HOLDER_A, TTL_MS).await,
        Err(LeaseError::NotFound(_))
    ));
    assert!(matches!(
        store.renew_lease("ghost", HOLDER_A, TTL_MS).await,
        Err(LeaseError::NotFound(_))
    ));
    assert!(matches!(
        store.check_lease("ghost").await,
        Err(LeaseError::NotFound(_))
    ));
}

/// SPEC「状态提交、租约与取消」：重开存储（同库）后状态、事件与租约仍在
/// （持久化而非内存态），接管恢复沿用快照。
#[tokio::test]
async fn reopen_keeps_persisted_state_and_lease() {
    let clock = FakeClock::start_at(5_000);
    let dir = tempfile::tempdir().expect("创建临时目录");
    let path = dir.path().join("runs.db");
    let store = SqliteRunStore::open(&path, clock.clone()).expect("打开");
    let wf = chain_workflow();
    let run = initial_run(&wf);
    store.create_run(&run, &empty_roles()).await.expect("创建运行");
    let run_id = run.id.clone();

    let held_generation = store.acquire_lease(&run_id, HOLDER_A, TTL_MS).await.expect("获取租约");
    let mut run = store.get_run(&run_id).await.expect("读取").unwrap();
    run.status = RunStatus::Running;
    store
        .commit_run(&run, held_generation, &[event("进度")])
        .await
        .expect("提交");
    drop(store);

    // 同一时钟重开。
    let reopened = SqliteRunStore::open(&path, clock).expect("重开");
    let run = reopened.get_run(&run_id).await.expect("读取").unwrap();
    assert_eq!(run.status, RunStatus::Running);
    assert_eq!(run.generation, held_generation);
    assert_eq!(reopened.list_events(&run_id).await.expect("读取事件").len(), 1);
    let lease = reopened.check_lease(&run_id).await.expect("查询租约").expect("有租约");
    assert_eq!(lease.holder, HOLDER_A);
}

/// SPEC「顺序执行与输入交接」存储侧：节点 attempts / reworks 随 commit
/// 持久化，可区分当前状态与历史累计。
#[tokio::test]
async fn node_counters_persist_across_commits() {
    let clock = FakeClock::start_at(0);
    let (_dir, store) = open_store(clock);
    let wf = chain_workflow();
    let run = initial_run(&wf);
    store.create_run(&run, &empty_roles()).await.expect("创建运行");
    let run_id = run.id.clone();

    // 第一次提交：A 置 running，attempts=1。
    let mut run = store.get_run(&run_id).await.expect("读取").unwrap();
    run.nodes[0].status = NodeStatus::Running;
    run.nodes[0].attempts = 1;
    store.commit_run(&run, 1, &[]).await.expect("提交");

    // 第二次提交（新代数）：失败重试后 attempts=2，带 error。
    store.acquire_lease(&run_id, HOLDER_A, TTL_MS).await.expect("获取新代数");
    let mut run = store.get_run(&run_id).await.expect("读取").unwrap();
    run.status = RunStatus::Failed;
    run.nodes[0].attempts = 2;
    run.nodes[0].status = NodeStatus::Failed;
    run.nodes[0].error = Some("执行失败".to_string());
    store.commit_run(&run, 2, &[]).await.expect("提交");

    let final_run = store.get_run(&run_id).await.expect("读取").unwrap();
    let a = node(&final_run, "A");
    assert_eq!(a.attempts, 2, "attempts 单调持久");
    assert_eq!(a.status, NodeStatus::Failed);
    assert_eq!(a.error.as_deref(), Some("执行失败"));
    assert_eq!(node(&final_run, "B").status, NodeStatus::Pending);
}

// ---------- 产物归属（第二阶段） ----------

fn contract(name: &str, path: &str) -> ursi_domain::ArtifactContract {
    ursi_domain::ArtifactContract {
        name: name.to_string(),
        path: path.to_string(),
        required: false,
        media_type: None,
    }
}

/// SPEC「顺序执行与输入交接」（DESIGN「状态、事件与产物」）：产物归属按
/// (run, node, generation, attempt) 落库，同一身份重复记录幂等，可枚举。
#[tokio::test]
async fn node_artifacts_recorded_by_execution_identity() {
    let clock = FakeClock::start_at(0);
    let (_dir, store) = open_store(clock);
    let wf = chain_workflow();
    let run = initial_run(&wf);
    store.create_run(&run, &empty_roles()).await.expect("创建运行");
    let run_id = run.id.clone();

    let declared = vec![contract("报告", "out/report.md"), contract("附录", "out/appendix.md")];
    store
        .record_node_artifacts(&run_id, "A", 2, 1, &declared)
        .await
        .expect("记录产物归属");
    // 同一身份重复记录：幂等（主键去重），不产生重复行。
    store
        .record_node_artifacts(&run_id, "A", 2, 1, &declared)
        .await
        .expect("重复记录幂等");
    // 返工后新 attempt：新记录与旧记录并存，旧记录保留可查询。
    store
        .record_node_artifacts(&run_id, "A", 2, 2, &declared)
        .await
        .expect("新轮次归属");

    let all = store.list_node_artifacts(&run_id).await.expect("列举");
    assert_eq!(all.len(), 4, "2 声明 × 2 attempt，无重复");
    assert!(all
        .iter()
        .all(|r| r.run_id == run_id && r.node_id == "A" && r.generation == 2));
    assert_eq!(
        all.iter().map(|r| r.attempt).collect::<std::collections::BTreeSet<_>>(),
        [1, 2].into_iter().collect(),
        "两个轮次的归属各自独立"
    );
    let round2: Vec<_> = all.iter().filter(|r| r.attempt == 2).collect();
    assert_eq!(
        round2.iter().map(|r| (r.name.as_str(), r.path.as_str())).collect::<Vec<_>>(),
        vec![("报告", "out/report.md"), ("附录", "out/appendix.md")]
    );
    // 未知运行返回空。
    assert!(store.list_node_artifacts("ghost").await.expect("读取").is_empty());
}

/// SPEC「查询、事件与资源收尾」：清理状态 pending → done / failed 持久化，
/// 重开存储后可查询。
#[tokio::test]
async fn cleanup_status_persists_and_roundtrips() {
    let clock = FakeClock::start_at(1_000);
    let dir = tempfile::tempdir().expect("临时目录");
    let path = dir.path().join("runs.db");
    let store = SqliteRunStore::open(&path, clock.clone()).expect("打开");
    let wf = chain_workflow();
    let run = initial_run(&wf);
    store.create_run(&run, &empty_roles()).await.expect("创建运行");
    let run_id = run.id.clone();

    // 未记录返回 None。
    assert!(store.cleanup_status(&run_id).await.expect("查询").is_none());
    store.set_cleanup_status(&run_id, CleanupState::Pending, None).await.expect("记录");
    let s = store.cleanup_status(&run_id).await.expect("查询").expect("存在");
    assert_eq!(s.state, CleanupState::Pending);

    store.set_cleanup_status(&run_id, CleanupState::Failed, Some("网关超时")).await.expect("记录");
    let s = store.cleanup_status(&run_id).await.expect("查询").expect("存在");
    assert_eq!(s.state, CleanupState::Failed);
    assert_eq!(s.error.as_deref(), Some("网关超时"));

    // 失败后重试成功：状态翻转到 done。
    store.set_cleanup_status(&run_id, CleanupState::Done, None).await.expect("记录");
    assert_eq!(
        store.cleanup_status(&run_id).await.expect("查询").expect("存在").state,
        CleanupState::Done
    );

    drop(store);
    let reopened = SqliteRunStore::open(&path, clock).expect("重开");
    let s = reopened.cleanup_status(&run_id).await.expect("查询").expect("重开后仍在");
    assert_eq!(s.state, CleanupState::Done);
}

/// SPEC「状态提交、租约与取消」+「审批、重试与返工」：同一持有代数内，
/// 旧 attempt 的迟到提交（节点 attempt 回退）被整体拒绝，状态与事件均不
/// 落库，当前结果不被覆盖。
#[tokio::test]
async fn stale_attempt_commit_rejected_within_same_generation() {
    let clock = FakeClock::start_at(0);
    let (_dir, store) = open_store(clock);
    let wf = chain_workflow();
    let run = initial_run(&wf);
    store.create_run(&run, &empty_roles()).await.expect("创建运行");
    let run_id = run.id.clone();

    // 当前轮次：A attempts=2、succeeded，带事件。
    let mut current = store.get_run(&run_id).await.expect("读取").unwrap();
    current.status = RunStatus::Running;
    {
        let a = current.nodes.iter_mut().find(|n| n.node_id == "A").unwrap();
        a.attempts = 2;
        a.status = NodeStatus::Succeeded;
        a.output = Some("第二轮产出".to_string());
    }
    store
        .commit_run(&current, 1, &[event("第二轮 node.succeeded")])
        .await
        .expect("提交");

    // 迟到提交：同一代数内以旧 attempt=1 的状态与事件提交，被拒。
    let mut late = store.get_run(&run_id).await.expect("读取").unwrap();
    {
        let a = late.nodes.iter_mut().find(|n| n.node_id == "A").unwrap();
        a.attempts = 1;
        a.status = NodeStatus::Failed;
        a.output = None;
        a.error = Some("旧 attempt 的迟到失败".to_string());
    }
    let err = store
        .commit_run(&late, 1, &[event("旧 attempt 迟到事件")])
        .await
        .expect_err("旧 attempt 提交必须被拒");
    assert!(matches!(err, crate::storage::StoreError::StaleGeneration(_)), "实际：{err:?}");

    // 当前结果不被覆盖，迟到事件未入库。
    let after = store.get_run(&run_id).await.expect("读取").unwrap();
    let a = node(&after, "A");
    assert_eq!(a.attempts, 2);
    assert_eq!(a.status, NodeStatus::Succeeded);
    assert_eq!(a.output.as_deref(), Some("第二轮产出"));
    let msgs: Vec<_> = store
        .list_events(&run_id)
        .await
        .expect("读取事件")
        .into_iter()
        .map(|r| r.event.message)
        .collect();
    assert_eq!(msgs, vec!["第二轮 node.succeeded".to_string()], "迟到事件不得入库");
}

/// SPEC「查询、事件与资源收尾」：提供运行列表查询，能按状态过滤，
/// 列表项含运行标识与状态摘要。
#[tokio::test]
async fn list_runs_filters_by_status_and_returns_summaries() {
    let (_clock, _dir, store) = open_store_at(1_000_000);

    for id in ["run-queued-1", "run-queued-2", "run-running-1"] {
        let mut run = initial_run(&chain_workflow());
        run.id = id.to_string();
        store
            .create_run(&run, &FrozenRoles::default())
            .await
            .expect("创建运行");
    }

    // 把第三个运行推进到 running，形成两种状态。
    let mut running = store.get_run("run-running-1").await.expect("读取").unwrap();
    running.status = RunStatus::Running;
    store
        .commit_run(&running, 1, &[])
        .await
        .expect("提交 running");

    // 全量列表：三条记录。
    let all = store.list_runs(&[]).await.expect("全量列表");
    assert_eq!(all.len(), 3);

    // 按状态过滤：仅 queued。
    let queued = store
        .list_runs(&[RunStatus::Queued])
        .await
        .expect("按状态过滤");
    assert_eq!(queued.len(), 2);
    assert!(queued.iter().all(|s| s.status == RunStatus::Queued));
    assert!(queued.iter().any(|s| s.id == "run-queued-1"));

    // 过滤 running：单条。
    let running = store
        .list_runs(&[RunStatus::Running])
        .await
        .expect("running 过滤");
    assert_eq!(running.len(), 1);
    assert_eq!(running[0].id, "run-running-1");

    // 状态推进后过滤结果随之变化。
    let mut run = store.get_run("run-running-1").await.expect("读取").unwrap();
    run.status = RunStatus::Succeeded;
    store.commit_run(&run, 1, &[]).await.expect("提交状态");
    let succeeded = store
        .list_runs(&[RunStatus::Succeeded])
        .await
        .expect("succeeded 过滤");
    assert_eq!(succeeded.len(), 1);
    assert_eq!(succeeded[0].id, "run-running-1");
}
