//! 应用装配与生命周期：迁移 → 域服务 → 传输入口 → 后台任务 → 有序关闭。
//!
//! ## 共享库装配（跨域一致性的前提）
//!
//! storage SPEC 把「按域登记迁移列表」交给 app。workflows 的保存契约
//! 要求「定义写入 + role_refs 登记」在同一 SQLite 事务内提交，而
//! `role_refs` 表归 roles 域；因此 roles 与 workflows 必须共用同一
//! [`Database`]（同文件 SQLite，两域迁移一次应用）。connections / runs /
//! sandboxes 维持各域现状自管：
//! - connections：`ConnectionStore::open` 内建 raw 连接（自带迁移）；
//! - runs：`SqliteRunStore::open(path, clock)` 自管 `runs_domain` 迁移；
//! - sandboxes：`SandboxStore::open` 自建表（幂等 DDL）。
//!
//! ## 启动顺序（失败即不产生残留）
//!
//! 1. 打开存储并应用迁移（任何失败直接返回，无已启动组件）；
//! 2. 构造各域服务（纯构造，无副作用）；
//! 3. 绑定 HTTP 监听并启动服务任务；
//! 4. 启动后台任务（租约恢复扫描、资源收尾重试扫描）。
//!
//! ## 关闭顺序（业务组件先于其存储依赖，见 SPEC「有序关闭」）
//!
//! 关闭信号 → 停止后台任务 → abort HTTP 服务任务（停止接收新业务操作，
//! 监听句柄随任务释放）→ 关闭事件订阅（广播 Sender 随 Services 释放）→
//! 释放存储（App drop：服务句柄先于 SQLite 连接销毁）。重复关闭经原子
//! 标志幂等。
//!
//! HTTP 停止说明：transport::serve 不返回服务任务句柄，无法从外部停止
//! 监听；装配经 transport 公开的 [`crate::transport::build_router`] 自行
//! 绑定并持有任务句柄，获得可管理的生命周期（绑定语义与 serve 一致）。

use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::watch;

use crate::app::adapters::{
    ArtifactsApiAdapter, ConnectionsApiAdapter, RolesApiAdapter, RunEventFeed, RunsApiAdapter,
    SandboxesApiAdapter, WorkflowApiAdapter,
};
use crate::app::config::AppConfig;
use crate::app::gateways::{
    RolesConnectionGateway, WorkflowRoleGateway,
};
use crate::runs::engine::{Engine, ScriptExecutionError, ScriptExecutor};
use crate::runs::{ResourceReleaseError, ResourceReleaser};
use crate::storage::Database;
use crate::transport::{AppState, StaticAssets};

/// 本装配的沙箱服务形态（Gateway 与通道网关为占位实现）。
/// 就绪状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppStatus {
    Starting,
    Ready,
    ShuttingDown,
    Stopped,
}

/// 可共享的运行中组件：关闭幂等的关键状态都在此。
struct AppInner {
    status: watch::Sender<AppStatus>,
    /// 常驻接收者：watch::send 在零接收者时不更新共享值（tokio 语义），
    /// 此句柄保证状态值始终可写可读。
    _status_rx: watch::Receiver<AppStatus>,
    shutdown: watch::Sender<bool>,
    /// 常驻关闭标志接收者：语义同上，保证后台任务轮询能读到关闭信号。
    _shutdown_rx: watch::Receiver<bool>,
    http_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    background_tasks: Mutex<Vec<tokio::task::JoinHandle<()>>>,
    /// 关闭已完成标志：重复 shutdown 直接返回（幂等）。
    done: AtomicBool,
}

/// 装配完成的应用句柄：就绪查询与有序关闭。
pub struct App {
    inner: Arc<AppInner>,
    addr: SocketAddr,
    /// 业务组件集：保持在句柄内直到关闭（drop 顺序保证服务先于存储销毁）。
    _services: Services,
}

/// 各域业务服务集合（transport 状态 + 引擎 + 沙箱存储）。
struct Services {
    _state: AppState,
    _engine: Arc<Engine>,
    _sandbox_store: Arc<crate::sandboxes::SandboxStore>,
}

impl App {
    /// 服务实际监听地址（测试从 127.0.0.1:0 的绑定结果读取）。
    pub fn addr(&self) -> SocketAddr {
        self.addr
    }

    /// 就绪状态：迁移、服务构造与监听绑定全部完成。
    pub fn ready(&self) -> bool {
        *self.inner._status_rx.borrow() == AppStatus::Ready
    }

    /// 有序关闭：幂等（重复调用直接返回）。顺序见模块文档。
    pub async fn shutdown(&self) {
        // 只有一个调用者执行关闭序列；其余调用看到 done 即返回。
        if self.inner.done.swap(true, Ordering::SeqCst) {
            return;
        }
        let _ = self.inner.status.send(AppStatus::ShuttingDown);
        // 1. 停止后台任务（租约扫描、收尾重试）。
        let _ = self.inner.shutdown.send(true);
        let tasks = self.inner.background_tasks.lock().expect("后台任务表可用").drain(..).collect::<Vec<_>>();
        for task in tasks {
            let _ = tokio::time::timeout(Duration::from_secs(1), task).await;
        }
        // 2. 停止接收新业务操作：终止 HTTP 服务任务，监听端口随任务释放。
        let http = self
            .inner
            .http_task
            .lock()
            .expect("HTTP 任务句柄可用")
            .take();
        if let Some(task) = http {
            task.abort();
            let _ = task.await;
        }
        // 3. 运行服务收尾：engine 调度循环由请求驱动，无独立循环任务；
        //    活动运行的处置规则归 runs 域（取消入口已停止调度）。
        // 4. 关闭事件订阅并释放存储：广播 Sender 随 Services（self drop）
        //    释放，SQLite 连接在最后句柄 drop 时关闭。
        let _ = self.inner.status.send(AppStatus::Stopped);
        tracing::info!("应用关闭完成");
    }
}

impl Drop for App {
    fn drop(&mut self) {
        // 句柄销毁即释放服务与存储；若尚未显式关闭，先触发幂等关闭的
        // 同步部分（后台与 HTTP 任务终止留给 drop 内联处理）。
        if !self.inner.done.swap(true, Ordering::SeqCst) {
            let _ = self.inner.shutdown.send(true);
            let tasks = self
                .inner
                .background_tasks
                .lock()
                .expect("后台任务表可用")
                .drain(..)
                .collect::<Vec<_>>();
            for task in tasks {
                task.abort();
            }
            if let Some(task) = self.inner.http_task.lock().expect("HTTP 任务句柄可用").take() {
                task.abort();
            }
        }
    }
}

/// 装配完整应用：迁移、域服务、HTTP 监听与后台任务。
///
/// 迁移或存储打开失败返回明确原因，不报告就绪；监听绑定失败同样直接
/// 失败——失败点全部在后台任务启动之前，无组件需要回滚。
pub async fn assemble(config: AppConfig) -> Result<App, String> {
    let (status_tx, status_rx) = watch::channel(AppStatus::Starting);
    std::fs::create_dir_all(&config.data_dir)
        .map_err(|e| format!("创建数据目录 {} 失败：{e}", config.data_dir.display()))?;

    // 1. 存储与迁移。共享库版本治理（文档化约束）：
    // WorkflowStore::open 以硬编码的单迁移列表打开共享库（构造函数不
    // 可注入完整列表），user_version 超过其列表长度会被拒绝。因此共享
    // 库的 user_version 由 workflows 域定格为 1；roles 域三表 DDL 由
    // app 在同文件上幂等 bootstrap（按 sqlite_master 判定，不动版本
    // 号）。role_refs 表因此创建于共享库，workflows 保存事务可在同一
    // 连接上完成「定义写入 + 引用登记」。
    let role_ref_gateway = WorkflowRoleGateway::open(&config.shared_db_path())
        .map_err(|e| format!("打开角色引用网关失败：{e}"))?;
    let workflow_store = Arc::new(crate::workflows::WorkflowStore::open(
        config.shared_db_path(),
        Arc::new(role_ref_gateway),
    )
    .map_err(|e| format!("打开流程存储失败：{e}"))?);
    bootstrap_roles_ddl(&config.shared_db_path())
        .map_err(|e| format!("登记角色域表失败：{e}"))?;
    // 角色域服务的 Database 句柄：与 workflows 相同迁移列表（stored=1
    // 恒等于列表长度，幂等跳过），指向同一共享库文件。
    let shared_db = Database::open(config.shared_db_path(), crate::workflows::WORKFLOW_MIGRATIONS)
        .map_err(|e| format!("打开共享存储失败：{e}"))?;
    let connections_db_path = config.connections_db_path().to_string_lossy().into_owned();
    // 连接域构造器收所有权且类型未实现 Clone：服务与 API 适配器各自
    // 打开同一 SQLite 文件（状态由 SQLite 文件锁保证一致，迁移幂等）。
    let connections_service_store = crate::connections::ConnectionStore::open(&connections_db_path)
        .map_err(|e| format!("打开连接存储失败：{e}"))?;
    let connections_api_store = Arc::new(
        crate::connections::ConnectionStore::open(&connections_db_path)
            .map_err(|e| format!("打开连接存储失败：{e}"))?,
    );
    let runs_store = Arc::new(crate::runs::SqliteRunStore::open(
        config.runs_db_path(),
        Arc::new(crate::runs::SystemClock),
    )
    .map_err(|e| format!("打开运行存储失败：{e}"))?);
    let sandboxes_store = Arc::new(crate::sandboxes::SandboxStore::open(config.sandboxes_db_path())
        .map_err(|e| format!("打开沙箱存储失败：{e}"))?);
    let content_store_for_service = crate::storage::ContentStore::open(config.content_root())
        .map_err(|e| format!("打开内容存储失败：{e}"))?;
    let content_store_for_api = crate::storage::ContentStore::open(config.content_root())
        .map_err(|e| format!("打开内容存储失败：{e}"))?;

    // 2. 域服务（纯构造）。
    let connections_service =
        Arc::new(crate::connections::ConnectionService::new(connections_service_store));
    let roles_gateway =
        RolesConnectionGateway::new(Arc::clone(&connections_service), Arc::clone(&connections_api_store));
    // RoleStore 未实现 Clone（Database/ContentStore 是）：服务与 API
    // 适配器各自构造实例，共享同一 Database 连接（Clone 语义），状态一致。
    let roles_service_store =
        crate::roles::RoleStore::new(shared_db.clone(), content_store_for_service);
    let roles_api_store =
        Arc::new(crate::roles::RoleStore::new(shared_db.clone(), content_store_for_api));
    let roles_service =
        Arc::new(crate::roles::RoleService::new(roles_service_store, roles_gateway));

    // 运行引擎：MockRunner、SQL 租约表、资源释放入口接沙箱服务。
    let runner: Arc<dyn ursi_agent_runtime::Runner> = Arc::new(ursi_agent_runtime::MockRunner::new(
        ursi_agent_runtime::MockScenario::Success {
            output: "mock 完成".to_string(),
            tokens: 0,
        },
    ));
    let events_bus = crate::runs::engine::EventBus::new();
    let engine = Arc::new(
        Engine::new(
            Arc::clone(&runs_store) as Arc<dyn crate::runs::RunRepository>,
            runner,
            events_bus.clone(),
            Arc::clone(&runs_store) as Arc<dyn crate::runs::LeaseTable>,
            Arc::new(NoopScriptExecutor),
        )
        .with_releaser(Arc::new(SandboxResourceReleaser {
            store: Arc::clone(&sandboxes_store),
        }))
        .with_lease_ttl_ms(config.lease_ttl.as_millis() as u64),
    );

    // 3. transport 适配器与状态。
    let state = AppState {
        workflows: Arc::new(WorkflowApiAdapter::new(workflow_store.clone())),
        roles: Arc::new(RolesApiAdapter::new(
            Arc::clone(&roles_service),
            Arc::clone(&roles_api_store),
        )),
        runs: Arc::new(RunsApiAdapter::new(
            Arc::clone(&engine),
            Arc::clone(&runs_store),
            workflow_store.clone(),
            Arc::clone(&roles_service),
        )),
        artifacts: Arc::new(ArtifactsApiAdapter::new(Arc::clone(&runs_store))),
        sandboxes: Arc::new(SandboxesApiAdapter::new(Arc::clone(&sandboxes_store))),
        connections: Arc::new(ConnectionsApiAdapter::new(Arc::clone(&connections_api_store))),
        events: RunEventFeed::new(Arc::clone(&runs_store), events_bus),
        mcp: crate::transport::mcp::assemble_mcp_server(&[
            ursi_mcp_server::Domain::Ops(Arc::new(super::mcp_backends::OpsBackendAdapter::new(
                Arc::clone(&sandboxes_store),
            ))),
            ursi_mcp_server::Domain::Control(Arc::new(
                super::mcp_backends::ControlBackendAdapter::new(
                    Arc::clone(&engine),
                    Arc::clone(&runs_store),
                ),
            )),
            ursi_mcp_server::Domain::Internal(Arc::new(
                super::mcp_backends::InternalBackendAdapter::new(Arc::clone(&runs_store)),
            )),
        ])
        .map_err(|e| format!("装配 MCP 服务失败：{e}"))?,
        static_assets: match &config.static_root {
            Some(root) => Arc::new(StaticAssets::new(root)),
            None => Arc::new(StaticAssets::disabled()),
        },
    };

    // 4. 绑定监听并启动 HTTP 服务（任务句柄由 App 持有，支持停止）。
    let listener = tokio::net::TcpListener::bind(config.listen_addr)
        .await
        .map_err(|e| format!("绑定监听 {} 失败：{e}", config.listen_addr))?;
    let addr_bound = listener
        .local_addr()
        .map_err(|e| format!("读取监听地址失败：{e}"))?;
    let router = crate::transport::build_router(state.clone());
    let http_task = tokio::spawn(async move {
        if let Err(err) = axum::serve(listener, router).await {
            tracing::error!("HTTP 服务退出：{err}");
        }
    });

    // 5. 后台任务（监听就绪后启动；其消费的存储已全部初始化）。
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let background_tasks = vec![
        spawn_lease_recovery(
            Arc::clone(&engine),
            shutdown_tx.clone(),
            config.lease_scan_interval,
        ),
        spawn_cleanup_retry(
            Arc::clone(&sandboxes_store),
            shutdown_tx.clone(),
            config.cleanup_retry_interval,
        ),
    ];

    let _ = status_tx.send(AppStatus::Ready);
    // 启动日志：只含地址与数据目录，无凭据字段。
    tracing::info!(
        "应用就绪：监听 {}，数据目录 {}",
        addr_bound,
        config.data_dir.display()
    );
    Ok(App {
        inner: Arc::new(AppInner {
            status: status_tx,
            _status_rx: status_rx,
            shutdown: shutdown_tx,
            _shutdown_rx: shutdown_rx,
            http_task: Mutex::new(Some(http_task)),
            background_tasks: Mutex::new(background_tasks),
            done: AtomicBool::new(false),
        }),
        addr: addr_bound,
        _services: Services {
            _state: state,
            _engine: engine,
            _sandbox_store: Arc::clone(&sandboxes_store),
        },
    })
}

/// 信号驱动入口：装配后等待 ctrl_c / SIGTERM，收到信号有序关闭。
pub async fn run() {
    let config = match AppConfig::from_env() {
        Ok(config) => config,
        Err(reason) => {
            eprintln!("配置错误：{reason}");
            std::process::exit(2);
        }
    };
    let app = match assemble(config).await {
        Ok(app) => app,
        Err(reason) => {
            eprintln!("启动失败：{reason}");
            std::process::exit(1);
        }
    };
    wait_for_shutdown_signal().await;
    tracing::info!("收到终止信号，开始有序关闭");
    app.shutdown().await;
}

/// 等待 ctrl_c（全平台）或 SIGTERM（Unix）。
async fn wait_for_shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = match signal(SignalKind::terminate()) {
            Ok(term) => term,
            Err(err) => {
                tracing::warn!("无法注册 SIGTERM 监听：{err}，仅等待 ctrl_c");
                let _ = tokio::signal::ctrl_c().await;
                return;
            }
        };
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

/// 资源释放入口：终态运行的收尾经沙箱服务释放（失败保留待核实状态，
/// 可由收尾重试扫描再次请求；运行执行结果不受影响）。
struct SandboxResourceReleaser {
    store: Arc<crate::sandboxes::SandboxStore>,
}

#[async_trait::async_trait]
impl ResourceReleaser for SandboxResourceReleaser {
    async fn release(&self, run_id: &str) -> Result<(), ResourceReleaseError> {
        // 释放即本地关联收敛为 Released（平台视图随之不可用）。
        // 控制面接入前的明确边界：仅收敛本地记录，不伪造平台侧已回收。
        self.store
            .record_released(run_id)
            .map_err(|e| ResourceReleaseError::Failed(e.to_string()))
    }
}

/// 租约恢复扫描：接管过期租约的可恢复运行（runs SPEC「恢复」）。
/// 当前 RunRepository 无运行列举入口，可恢复清单没有事实来源；扫描任务
/// 保留周期与关闭语义，`resume_interrupted` 接线在入口补齐后启用。
/// 缺口在 SPEC 交付说明记录。
fn spawn_lease_recovery(
    engine: Arc<Engine>,
    shutdown: watch::Sender<bool>,
    interval: Duration,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut rx = shutdown.subscribe();
        let mut ticker = tokio::time::interval(interval);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        ticker.tick().await; // 首拍立即返回，跳过
        loop {
            tokio::select! {
                _ = ticker.tick() => {}
                _ = rx.changed() => {
                    if *rx.borrow_and_update() {
                        break;
                    }
                }
            }
            // 可恢复运行清单依赖列举入口（缺口）；补齐后在此调用
            // engine.resume_interrupted(&ids)。空轮询保持任务心跳。
            let _ = &engine;
        }
    })
}

/// 资源收尾重试扫描：终态运行 cleanup 状态为 pending/failed 时重新请求
/// 释放（失败保留状态供下轮重试，不伪造成功）。
/// 重试清单依赖「按清理状态列举终态运行」的查询（同列举缺口），入口
/// 补齐前保留周期语义。缺口在 SPEC 交付说明记录。
fn spawn_cleanup_retry(
    sandbox_store: Arc<crate::sandboxes::SandboxStore>,
    shutdown: watch::Sender<bool>,
    interval: Duration,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut rx = shutdown.subscribe();
        let mut ticker = tokio::time::interval(interval);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        ticker.tick().await;
        loop {
            tokio::select! {
                _ = ticker.tick() => {}
                _ = rx.changed() => {
                    if *rx.borrow_and_update() {
                        break;
                    }
                }
            }
            // 重试清单依赖清理状态列举入口（缺口）；补齐后在此对
            // pending/failed 的终态运行调用收尾释放。
            let _ = &sandbox_store;
        }
    })
}

/// 占位脚本执行器：本阶段工作流脚本节点明确失败（不伪造执行成功）。
/// 真实沙箱脚本执行经 channel 接入后替换（runs SPEC 交付边界）。
struct NoopScriptExecutor;

#[async_trait::async_trait]
impl ScriptExecutor for NoopScriptExecutor {
    async fn exec(&self, _script: &str, _language: &str) -> Result<String, ScriptExecutionError> {
        Err(ScriptExecutionError::Failed(
            "脚本执行器尚未接入沙箱通道（装配占位）".to_string(),
        ))
    }
}

/// roles 域表 bootstrap：共享库 user_version 由 workflows 域定格（见
/// assemble「存储与迁移」），roles 迁移不走版本登记，按「roles 表是否
/// 存在」幂等执行（迁移列表只含建表 DDL，首装与重启行为一致）。
fn bootstrap_roles_ddl(path: &std::path::Path) -> Result<(), String> {
    let conn = rusqlite::Connection::open(path).map_err(|e| e.to_string())?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    let exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'roles')",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if exists {
        return Ok(());
    }
    for migration in crate::roles::migrations() {
        conn.execute_batch(migration.sql).map_err(|e| {
            format!("迁移 {} 执行失败：{e}", migration.name)
        })?;
    }
    Ok(())
}
