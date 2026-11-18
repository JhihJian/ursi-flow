//! 业务域注入接口：transport 与各业务域公开服务之间的窄契约。
//!
//! transport 不直接依赖任何业务域类型（除了 domain 共享契约），所有业务
//! 操作经这里定义的 trait 完成。app 装配时注入各域真实服务实现的适配器；
//! 本模块测试注入内存替身（见 tests/stubs.rs）。
//!
//! ## 与各业务域公开服务的对接点（app 装配参考）
//!
//! | trait | 对接的域公开服务 | 说明 |
//! |---|---|---|
//! | [`WorkflowApi`] | `crate::workflows::WorkflowStore` | 直接适配：create/list/get/update/delete。方法返回 `WorkflowDefinition`，与 store 同构 |
//! | [`RolesApi`] | `crate::roles::RoleService` + `RoleStore` | 适配器组合两处：RoleService 拥有校验保存与复制交付；删除需经 store 的引用检查。DTO `RoleDto` 以 serde camelCase 对齐 `RoleDefinition` 的可交付字段 |
//! | [`RunsApi`] | runs 域公开服务入口（runs SPEC「对外提供创建、启动、查询、取消、审批及事件读取服务」） | 适配 runs 公开入口；RunDto 保留快照与节点状态，事件记录持久序号 |
//! | [`ArtifactsApi`] | `crate::artifacts` 公开读取接口（稳定标识读元数据 + 按运行列举，对齐 artifacts SPEC「稳定读取与范围列举」） | 列表按创建时间排序保证稳定顺序 |
//! | [`SandboxesApi`] | `crate::sandboxes::SandboxService` | prepare/status/release 一一对应服务方法 |
//! | [`ConnectionsApi`] | `crate::connections::ConnectionStore`（CRUD）+ `ConnectionService` | view/list 与 `ConnectionView` 对齐；删除的引用检查由 store 事务内完成 |
//! | [`EventFeed`] | runs 持久事件存储与实时通知（runs SPEC「查询、事件与资源收尾」） | read_since 是历史重放事实来源，subscribe 只作实时通知 |
//!
//! 替身（测试）与真实适配器（app）都必须把本域错误映射为
//! [`ApiError`]：NotFound / Conflict / BadRequest / Forbidden / Internal。

use async_trait::async_trait;
use flow_core::domain::{Run, RunStatus, TelemetryEvent, WorkflowDefinition};

use crate::transport::error::ApiError;

// ---------------------------------------------------------------------------
// workflows
// ---------------------------------------------------------------------------

/// 流程定义接口。直接对齐 [`crate::workflows::WorkflowStore`] 的方法集
/// （create/list/get/update/delete），签名使用 domain 共享契约。
#[async_trait]
pub trait WorkflowApi: Send + Sync {
    async fn create_workflow(&self, definition: WorkflowDefinition)
        -> Result<WorkflowDefinition, ApiError>;
    async fn list_workflows(&self) -> Result<Vec<WorkflowDefinition>, ApiError>;
    async fn get_workflow(&self, id: &str) -> Result<WorkflowDefinition, ApiError>;
    async fn update_workflow(&self, id: &str, definition: WorkflowDefinition)
        -> Result<WorkflowDefinition, ApiError>;
    async fn delete_workflow(&self, id: &str) -> Result<(), ApiError>;
}

// ---------------------------------------------------------------------------
// roles
// ---------------------------------------------------------------------------

/// 角色配置 DTO：域 `RoleDefinition`（base + Skills 文件包 + MCP 配置 +
/// 连接选择）的可交付投影。脱敏边界：不含任何凭据字段；MCP 配置里的
/// 凭据引用（`{{cred:...}}`）原样保留，凭据明文不可能出现在该结构中
///（roles 域在保存时已拒绝明文敏感参数）。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleDto {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub skills: Vec<RoleSkillDto>,
    #[serde(default)]
    pub mcp_servers: Vec<RoleMcpServerDto>,
    /// 模型连接选择（connections 连接标识）。
    pub connection_id: String,
    /// 执行器类型选择（如 cli:claude-code），None 由装配决定。
    #[serde(default)]
    pub executor_kind: Option<String>,
}

/// Skills 文件包中的单个文件。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleSkillDto {
    pub path: String,
    /// 文件内容（UTF-8）。skills 以内容随角色交付。
    pub content: String,
}

/// 结构化 MCP 配置（stdio / http 二选一）。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "transport", rename_all = "snake_case")]
pub enum RoleMcpServerDto {
    Stdio {
        server: String,
        command: String,
        #[serde(default)]
        args: Vec<String>,
        /// 环境变量键值对；值仅允许凭据引用，不含明文。
        #[serde(default)]
        env: Vec<(String, String)>,
    },
    Http {
        server: String,
        url: String,
        /// 请求头键值对；值仅允许凭据引用，不含明文。
        #[serde(default)]
        headers: Vec<(String, String)>,
    },
}

/// 角色配置接口。对接 `crate::roles::RoleService` / `RoleStore`：
/// create/update 走 RoleService 的校验保存，delete 走 store 的引用检查删除，
/// list/get 复制语义无差别读取完整定义。
#[async_trait]
pub trait RolesApi: Send + Sync {
    async fn create_role(&self, role: RoleDto) -> Result<RoleDto, ApiError>;
    async fn list_roles(&self) -> Result<Vec<RoleDto>, ApiError>;
    async fn get_role(&self, id: &str) -> Result<RoleDto, ApiError>;
    async fn update_role(&self, id: &str, role: RoleDto) -> Result<RoleDto, ApiError>;
    async fn delete_role(&self, id: &str) -> Result<(), ApiError>;
}

// ---------------------------------------------------------------------------
// runs
// ---------------------------------------------------------------------------

/// 节点状态记录 DTO（domain `NodeRun` 投影）。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeRunDto {
    pub node_id: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default)]
    pub attempt: u32,
}

/// 运行 DTO：domain `Run` 的 JSON 投影（camelCase）。
///
/// 工作流快照的相等性按 JSON 字段值比较（domain 类型未实现 PartialEq）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunDto {
    pub id: String,
    pub status: String,
    /// 冻结的工作流快照。
    pub workflow: WorkflowDefinition,
    #[serde(default)]
    pub nodes: Vec<NodeRunDto>,
    /// 运行代数（状态提交守卫）。
    #[serde(default)]
    pub generation: u64,
}

impl RunDto {
    /// 从 domain `Run` 构造（runs 域真实服务适配器使用）。
    pub fn from_domain(run: &Run) -> Self {
        RunDto {
            id: run.id.clone(),
            status: run.status.as_str().to_string(),
            workflow: run.workflow.clone(),
            nodes: run
                .nodes
                .iter()
                .map(|n| NodeRunDto {
                    node_id: n.node_id.clone(),
                    status: n.status.as_str().to_string(),
                    output: n.output.clone(),
                    error: n.error.clone(),
                    attempt: n.attempts,
                })
                .collect(),
            generation: run.generation,
        }
    }

    /// 还原为 domain `Run`（runs 域真实服务适配器使用）。
    pub fn into_domain(self) -> Run {
        Run {
            id: self.id,
            workflow: self.workflow,
            status: RunStatus::parse(&self.status).unwrap_or(RunStatus::Queued),
            nodes: self
                .nodes
                .into_iter()
                .map(|n| flow_core::domain::NodeRun {
                    node_id: n.node_id,
                    status: flow_core::domain::NodeStatus::parse(&n.status)
                        .unwrap_or(flow_core::domain::NodeStatus::Pending),
                    output: n.output,
                    error: n.error,
                    attempts: n.attempt,
                    reworks: 0,
                })
                .collect(),
            generation: self.generation,
        }
    }
}

/// 创建运行的请求。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRunRequest {
    /// 工作流标识。
    pub workflow_id: String,
    /// 任务输入。
    #[serde(default)]
    pub input: String,
}

/// 审批请求体：`approved=true` 放行，`false` 打回（需 target_node_id）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequest {
    /// 审批节点标识。
    pub node_id: String,
    pub approved: bool,
    /// 打回目标节点；仅 `approved=false` 时必填，必须是传递祖先。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_node_id: Option<String>,
}

/// 运行接口。对接 runs 域公开服务（runs SPEC 功能意图）。
#[async_trait]
pub trait RunsApi: Send + Sync {
    /// 从流程定义创建运行并冻结快照，返回 queued 运行。
    async fn create_run(&self, request: CreateRunRequest) -> Result<RunDto, ApiError>;
    /// 启动运行。
    async fn start_run(&self, run_id: &str) -> Result<RunDto, ApiError>;
    /// 放行等待审批的节点。
    async fn approve(&self, run_id: &str, node_id: &str) -> Result<RunDto, ApiError>;
    /// 打回：重置到目标节点（必须是传递祖先）重新执行。
    async fn reject(&self, run_id: &str, node_id: &str, target_node_id: &str)
        -> Result<RunDto, ApiError>;
    /// 取消运行（幂等）。
    async fn cancel_run(&self, run_id: &str) -> Result<RunDto, ApiError>;
    async fn get_run(&self, run_id: &str) -> Result<RunDto, ApiError>;
    async fn list_runs(&self) -> Result<Vec<RunDto>, ApiError>;
}

// ---------------------------------------------------------------------------
// artifacts
// ---------------------------------------------------------------------------

/// 产物 DTO（含归属）。凭据与内容无关，无脱敏点；content 为可选项
///（元数据视图不携带内容字节）。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactDto {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
    pub run_id: String,
    #[serde(default)]
    pub node_id: String,
    #[serde(default)]
    pub attempt: u32,
    /// 产物字节（GET 单个产物时返回）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
}

/// 产物接口。对接 `crate::artifacts` 公开读取接口：
/// get 返回元数据 + 内容；list 按运行过滤、按创建时间稳定排序。
#[async_trait]
pub trait ArtifactsApi: Send + Sync {
    async fn get_artifact(&self, artifact_id: &str) -> Result<ArtifactDto, ApiError>;
    async fn list_artifacts(&self, run_id: Option<&str>) -> Result<Vec<ArtifactDto>, ApiError>;
}

// ---------------------------------------------------------------------------
// sandboxes
// ---------------------------------------------------------------------------

/// 沙箱 DTO：运行关联与平台状态视图。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxDto {
    pub id: String,
    /// 归属运行，空表示未绑定运行。
    pub run_id: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
    /// 为 true 表示来自本地记录，不是本次查询核实的状态或端点。
    pub last_observed: bool,
    /// 本地关联记录更新时间，不等同于最近一次成功的 Gateway 查询时间。
    pub updated_at: String,
}

/// 准备沙箱的请求。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareSandboxRequest {
    pub run_id: String,
    /// 运行冻结的沙箱配置（镜像等），透传给 sandboxes 域。
    #[serde(default)]
    pub spec: serde_json::Value,
}

/// 沙箱接口。对接 `crate::sandboxes::SandboxService` 的
/// prepare / status / release 语义。
#[async_trait]
pub trait SandboxesApi: Send + Sync {
    /// 请求 Gateway 准备资源并记录关联。
    async fn prepare(&self, request: PrepareSandboxRequest) -> Result<SandboxDto, ApiError>;
    /// 按运行关联核实资源状态。
    async fn get_sandbox(&self, run_id: &str) -> Result<SandboxDto, ApiError>;
    /// 仅读本地关联，可以离线列举或按运行过滤。
    async fn list_sandboxes(&self, run_id: Option<&str>) -> Result<Vec<SandboxDto>, ApiError>;
    /// 释放资源；失败或结果未知时保留待核实状态（不删除记录）。
    async fn release(&self, run_id: &str) -> Result<SandboxDto, ApiError>;
}

// ---------------------------------------------------------------------------
// connections
// ---------------------------------------------------------------------------

/// 连接配置 DTO。脱敏边界：只有凭据引用，不含密钥明文——对齐
/// connections `ConnectionView`（显式排除凭据字段的交付视图）。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionDto {
    pub id: String,
    pub name: String,
    /// 服务类型（openai_compatible / anthropropic / 其他注册值）。
    pub service_type: String,
    pub endpoint: String,
    /// 凭据引用（不是密钥本身）。
    pub credential_ref: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
}

/// 连接配置接口。对接 `crate::connections::ConnectionStore`（CRUD）与
/// `ConnectionService`（view/list 交付）。
#[async_trait]
pub trait ConnectionsApi: Send + Sync {
    async fn create_connection(&self, connection: ConnectionDto) -> Result<ConnectionDto, ApiError>;
    async fn list_connections(&self) -> Result<Vec<ConnectionDto>, ApiError>;
    async fn get_connection(&self, id: &str) -> Result<ConnectionDto, ApiError>;
    async fn update_connection(&self, id: &str, connection: ConnectionDto)
        -> Result<ConnectionDto, ApiError>;
    async fn delete_connection(&self, id: &str) -> Result<(), ApiError>;
}

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

/// 单条持久事件记录：运行标识 + 单调序号 + 事件内容。
/// 序号由 runs 在提交时确定，提交、查询和广播使用同一记录身份。
///（domain TelemetryEvent 未实现 PartialEq，本类型不用 derive 比较）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NumberedEvent {
    pub run_id: String,
    pub seq: u64,
    #[serde(flatten)]
    pub event: TelemetryEvent,
}

/// SSE 帧负载：事件 + 可继续读取的游标（当前最大 seq）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventFrame {
    pub seq: u64,
    #[serde(flatten)]
    pub event: TelemetryEvent,
}

/// 事件流实时通知通道。替身与 runs 真实实现均用 tokio mpsc/broadcast。
pub type EventStream = tokio::sync::mpsc::Receiver<NumberedEvent>;

/// 事件源接口：历史重放（事实来源）+ 实时通知。
///
/// 对接 runs 持久事件存储（runs SPEC「查询、事件与资源收尾」）。
#[async_trait]
pub trait EventFeed: Send + Sync {
    /// 建立实时通知订阅，只推送建立订阅之后该运行提交的事件。
    /// 客户端断开时通道关闭（Sender drop），实现方据此释放订阅资源。
    fn subscribe(&self, run_id: &str) -> EventStream;

    /// 从持久事件源按游标增量读取：返回 seq > after_seq 的记录，按 seq 升序。
    async fn read_since(
        &self,
        run_id: &str,
        after_seq: u64,
    ) -> Result<Vec<NumberedEvent>, ApiError>;
}
