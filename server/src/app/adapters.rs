//! transport 注入接口的域适配器：把各业务域公开服务包装为 transport 的
//! Api trait 实现（DESIGN「依赖方向与公开边界」：app 是唯一同时见到各域
//! 公开服务与 transport 端口的装配点）。
//!
//! 职责只有两件事：
//! 1. 同步域接口（rusqlite）经 `block_in_place` 进入异步端口方法；
//! 2. 域错误 → [`ApiError`] 映射。域 Display 已脱敏（各域 error.rs 契约），
//!    适配器不拼接任何字段值，凭据明文不可能进入错误文本。
//!
//! ## 已知装配缺口（域接口现状，在 SPEC 交付说明中记录，不在此修补）
//! - runs 事件序号是 `i64`，transport 游标是 `u64`（见 [`RunEventFeed`]）。

use std::sync::Arc;

use async_trait::async_trait;
use tokio::task::block_in_place;
use flow_core::domain::{NodeType, WorkflowDefinition};

use crate::artifacts::{ArtifactError, ArtifactRecord, ArtifactStore};
use crate::connections::{ConnectionChanges, ConnectionError, ConnectionStore, NewConnection, ServiceType};
use crate::storage::StoreError;
use crate::transport::error::ApiError;
use crate::runs::RunRepository;
use crate::transport::ports::{
    ArtifactDto, ArtifactsApi, ConnectionDto, ConnectionsApi, CreateRunRequest, EventFeed,
    EventStream, NumberedEvent, RoleDto, RolesApi, RunDto, RunsApi, WorkflowApi,
};
use crate::workflows::{WorkflowStore, WorkflowError};

// ---------------------------------------------------------------------------
// 错误映射（全部依赖域 Display 脱敏契约，不拼接字段值）
// ---------------------------------------------------------------------------

/// storage 层错误 → ApiError。
pub(crate) fn storage_to_api(err: &StoreError) -> ApiError {
    match err {
        StoreError::NotFound(id) => ApiError::not_found(id),
        StoreError::StaleGeneration(_) => ApiError::conflict("状态已被并发修改，请重试"),
        StoreError::Storage(_) => ApiError::Internal,
    }
}

/// workflows 域错误 → ApiError。
fn workflow_to_api(err: WorkflowError) -> ApiError {
    match err {
        WorkflowError::NotFound(id) => ApiError::not_found(format!("流程 {id}")),
        WorkflowError::AlreadyExists(id) => ApiError::conflict(format!("流程 {id} 已存在")),
        WorkflowError::Invalid(source) => {
            ApiError::bad_request(format!("定义结构校验失败：{source}"))
        }
        WorkflowError::RoleMissing { node_id, role_id } => {
            ApiError::conflict(format!("节点 {node_id} 引用的角色不存在：{role_id}"))
        }
        WorkflowError::RoleGateway(err) => ApiError::conflict(err.to_string()),
        WorkflowError::Storage(_) => ApiError::Internal,
    }
}

/// connections 域错误 → ApiError（Display 全脱敏）。
fn connection_to_api(err: ConnectionError) -> ApiError {
    match err {
        ConnectionError::NotFound(id) => ApiError::not_found(format!("连接 {id}")),
        ConnectionError::Validation(source) => ApiError::bad_request(source.to_string()),
        ConnectionError::Conflict(_)
        | ConnectionError::CredentialMissing(_)
        | ConnectionError::CredentialAccessFailed(_)
        | ConnectionError::CapabilityUnknown(_)
        | ConnectionError::CapabilityMismatch(_) => ApiError::conflict(err.to_string()),
        ConnectionError::Storage(_) => ApiError::Internal,
    }
}

/// roles 域错误 → ApiError（Display 全脱敏）。
fn roles_to_api(err: crate::roles::RolesError) -> ApiError {
    use crate::roles::RolesError;
    match err {
        RolesError::NotFound(id) => ApiError::not_found(format!("角色 {id}")),
        RolesError::Validation(_) | RolesError::Connection(_) => {
            ApiError::bad_request(err.to_string())
        }
        RolesError::Conflict(_) | RolesError::Gateway(_) => ApiError::conflict(err.to_string()),
        RolesError::Storage(_) => ApiError::Internal,
    }
}

/// runs 域引擎错误 → ApiError。
fn engine_to_api(err: crate::runs::engine::EngineError) -> ApiError {
    use crate::runs::engine::EngineError;
    match err {
        EngineError::RunNotFound(id) => ApiError::not_found(format!("运行 {id}")),
        EngineError::NodeNotFound(..) => ApiError::not_found(err.to_string()),
        EngineError::StateConflict(_) | EngineError::OutcomeUnknown(_) => {
            ApiError::conflict(err.to_string())
        }
        EngineError::InvalidDefinition(source) => {
            ApiError::bad_request(format!("定义结构校验失败：{source}"))
        }
        EngineError::FrozenRoleMissing { .. } | EngineError::FrozenRoleInvalid { .. } => {
            ApiError::conflict(err.to_string())
        }
        EngineError::Store(source) => storage_to_api(&source),
        EngineError::Executor(source) => ApiError::conflict(source.to_string()),
        EngineError::Lease(_)
        | EngineError::Script(_)
        | EngineError::LateAttemptDiscarded { .. } => ApiError::conflict(err.to_string()),
        EngineError::ReleaserNotConfigured | EngineError::DriverTask(_) => ApiError::Internal,
    }
}

// ---------------------------------------------------------------------------
// workflows
// ---------------------------------------------------------------------------

/// [`WorkflowApi`] 的 workflows 域适配器。
pub(crate) struct WorkflowApiAdapter {
    store: Arc<WorkflowStore>,
}

impl WorkflowApiAdapter {
    pub(crate) fn new(store: Arc<WorkflowStore>) -> Self {
        Self { store }
    }
}

#[async_trait]
impl WorkflowApi for WorkflowApiAdapter {
    async fn create_workflow(
        &self,
        definition: WorkflowDefinition,
    ) -> Result<WorkflowDefinition, ApiError> {
        block_in_place(|| self.store.create(definition).map_err(workflow_to_api))
    }

    async fn list_workflows(&self) -> Result<Vec<WorkflowDefinition>, ApiError> {
        block_in_place(|| self.store.list().map_err(workflow_to_api))
    }

    async fn get_workflow(&self, id: &str) -> Result<WorkflowDefinition, ApiError> {
        block_in_place(|| self.store.get(id).map_err(workflow_to_api))
    }

    async fn update_workflow(
        &self,
        id: &str,
        definition: WorkflowDefinition,
    ) -> Result<WorkflowDefinition, ApiError> {
        let store = &self.store;
        block_in_place(|| {
            // 存储契约以 def.id 定位；以路径 id 为准（与 REST 语义一致），
            // 定义不存在时 store.update 返回 NotFound。
            let mut def = definition;
            def.id = id.to_string();
            store.update(def).map_err(workflow_to_api)
        })
    }

    async fn delete_workflow(&self, id: &str) -> Result<(), ApiError> {
        block_in_place(|| self.store.delete(id).map_err(workflow_to_api))
    }
}

// ---------------------------------------------------------------------------
// roles
// ---------------------------------------------------------------------------

/// transport DTO → roles 完整聚合。校验失败（路径非法、缺入口文件）在
/// 落库前以 400 返回，不产生持久化副作用。
pub(crate) fn role_dto_to_definition(dto: RoleDto) -> Result<crate::roles::RoleDefinition, ApiError> {
    use crate::roles::{McpServerConfig, RoleDefinition, SkillFile, SkillPackage};

    let base = flow_core::domain::Role {
        id: dto.id,
        name: dto.name,
        prompt: dto.prompt,
        model: dto.model,
        // skills 名称清单与文件包是两个维度（roles model.rs 契约）；
        // DTO 的 skills 即文件列表，名称清单取包内文件路径。
        skills: dto.skills.iter().map(|s| s.path.clone()).collect(),
        mcp_servers: dto
            .mcp_servers
            .iter()
            .map(|m| match m {
                crate::transport::ports::RoleMcpServerDto::Stdio { server, .. }
                | crate::transport::ports::RoleMcpServerDto::Http { server, .. } => server.clone(),
            })
            .collect(),
        executor_id: None,
    };
    let executor_kind = dto.executor_kind.as_deref()
        .map(|kind| flow_core::domain::ExecutorKind::parse(kind)
            .ok_or_else(|| ApiError::bad_request("executorKind 不能为空")))
        .transpose()?;
    reject_legacy_executor(executor_kind.as_ref().map(|kind| kind.as_str()))?;
    let skill_package = SkillPackage::with_entry(
        crate::roles::SKILL_ENTRY,
        dto.skills
            .into_iter()
            .map(|s| SkillFile::new(s.path, s.content.into_bytes()))
            .collect(),
    )
    .map_err(|e| ApiError::bad_request(format!("skills 文件包校验失败：{e}")))?;
    let mcp_servers_config = dto
        .mcp_servers
        .into_iter()
        .map(|m| match m {
            crate::transport::ports::RoleMcpServerDto::Stdio { server, command, args, env } => {
                McpServerConfig::Stdio { server, command, args, env }
            }
            crate::transport::ports::RoleMcpServerDto::Http { server, url, headers } => {
                McpServerConfig::Http { server, url, headers }
            }
        })
        .collect();
    Ok(RoleDefinition {
        base,
        skill_package,
        mcp_servers_config,
        connection_id: dto.connection_id,
        executor_kind,
    })
}

/// roles 完整聚合 → transport DTO。
pub(crate) fn role_definition_to_dto(def: &crate::roles::RoleDefinition) -> RoleDto {
    use crate::roles::McpServerConfig;
    use crate::transport::ports::{RoleMcpServerDto, RoleSkillDto};

    let skills = def
        .skill_package
        .files
        .iter()
        .map(|f| RoleSkillDto {
            path: f.path.clone(),
            content: String::from_utf8_lossy(&f.bytes).into_owned(),
        })
        .collect();
    let mcp_servers = def
        .mcp_servers_config
        .iter()
        .map(|cfg| match cfg {
            McpServerConfig::Stdio { server, command, args, env } => {
                RoleMcpServerDto::Stdio {
                    server: server.clone(),
                    command: command.clone(),
                    args: args.clone(),
                    env: env.clone(),
                }
            }
            McpServerConfig::Http { server, url, headers } => RoleMcpServerDto::Http {
                server: server.clone(),
                url: url.clone(),
                headers: headers.clone(),
            },
        })
        .collect();
    RoleDto {
        id: def.base.id.clone(),
        name: def.base.name.clone(),
        prompt: def.base.prompt.clone(),
        model: def.base.model.clone(),
        skills,
        mcp_servers,
        connection_id: def.connection_id.clone(),
        executor_kind: def.executor_kind.as_ref().map(|k| k.as_str().to_string()),
    }
}

/// [`RolesApi`] 的 roles 域适配器：save 走 RoleService（连接校验与补偿
/// 语义），delete 走 RoleStore（引用检查删除），读取两者皆可。
pub(crate) struct RolesApiAdapter {
    service: Arc<crate::roles::RoleService<super::gateways::RolesConnectionGateway>>,
    store: Arc<crate::roles::RoleStore>,
}

impl RolesApiAdapter {
    pub(crate) fn new(
        service: Arc<crate::roles::RoleService<super::gateways::RolesConnectionGateway>>,
        store: Arc<crate::roles::RoleStore>,
    ) -> Self {
        Self { service, store }
    }
}

#[async_trait]
impl RolesApi for RolesApiAdapter {
    async fn create_role(&self, role: RoleDto) -> Result<RoleDto, ApiError> {
        let definition = role_dto_to_definition(role)?;
        self.service
            .save(&definition)
            .await
            .map_err(roles_to_api)?;
        // save 成功后必能读回；读不到按内部故障处理。
        let read_back = block_in_place(|| {
            self.store
                .get(&definition.base.id)
                .map_err(roles_to_api)
        })?;
        read_back
            .map(|def| role_definition_to_dto(&def))
            .ok_or(ApiError::Internal)
    }

    async fn list_roles(&self) -> Result<Vec<RoleDto>, ApiError> {
        let defs = self.service.list().await.map_err(roles_to_api)?;
        Ok(defs.iter().map(role_definition_to_dto).collect())
    }

    async fn get_role(&self, id: &str) -> Result<RoleDto, ApiError> {
        let def = self
            .service
            .get(id)
            .await
            .map_err(roles_to_api)?
            .ok_or_else(|| ApiError::not_found(format!("角色 {id}")))?;
        Ok(role_definition_to_dto(&def))
    }

    async fn update_role(&self, id: &str, role: RoleDto) -> Result<RoleDto, ApiError> {
        let mut definition = role_dto_to_definition(role)?;
        definition.base.id = id.to_string();
        // save 是 upsert 语义；REST PUT 要求资源存在，先检查。
        let exists = self
            .service
            .get(id)
            .await
            .map_err(roles_to_api)?
            .is_some();
        if !exists {
            return Err(ApiError::not_found(format!("角色 {id}")));
        }
        self.service
            .save(&definition)
            .await
            .map_err(roles_to_api)?;
        self.get_role(id).await
    }

    async fn delete_role(&self, id: &str) -> Result<(), ApiError> {
        block_in_place(|| self.store.delete(id).map(|_| ()).map_err(roles_to_api))
    }
}

// ---------------------------------------------------------------------------
// connections
// ---------------------------------------------------------------------------

/// [`ConnectionsApi`] 的 connections 域适配器：写入走 store（返回完整
/// 模型含凭据引用），读取走 service 交付视图（无凭据字段）。
pub(crate) struct ConnectionsApiAdapter {
    store: Arc<ConnectionStore>,
}

impl ConnectionsApiAdapter {
    pub(crate) fn new(store: Arc<ConnectionStore>) -> Self {
        Self { store }
    }

    fn to_dto(c: &crate::connections::ModelConnection) -> ConnectionDto {
        ConnectionDto {
            id: c.id.clone(),
            name: c.name.clone(),
            service_type: c.service_type.as_str().to_string(),
            endpoint: c.endpoint.clone(),
            credential_ref: c.credential_ref.clone(),
            created_at: c.created_at.clone(),
        }
    }

}

#[async_trait]
impl ConnectionsApi for ConnectionsApiAdapter {
    async fn create_connection(&self, connection: ConnectionDto) -> Result<ConnectionDto, ApiError> {
        let created = block_in_place(|| {
            self.store
                .create(NewConnection {
                    name: connection.name,
                    service_type: ServiceType::parse(&connection.service_type),
                    endpoint: connection.endpoint,
                    credential_ref: connection.credential_ref,
                })
                .map_err(connection_to_api)
        })?;
        Ok(Self::to_dto(&created))
    }

    async fn list_connections(&self) -> Result<Vec<ConnectionDto>, ApiError> {
        // 连接条目仅含凭据引用（无明文），与创建/更新响应一致；服务层
        // list_views 需要独占 store 所有权（当前接口限制），经 store 投影。
        let all = block_in_place(|| self.store.list().map_err(connection_to_api))?;
        Ok(all.iter().map(Self::to_dto).collect())
    }

    async fn get_connection(&self, id: &str) -> Result<ConnectionDto, ApiError> {
        let record = block_in_place(|| self.store.get(id).map_err(connection_to_api))?;
        Ok(Self::to_dto(&record))
    }

    async fn update_connection(
        &self,
        id: &str,
        connection: ConnectionDto,
    ) -> Result<ConnectionDto, ApiError> {
        let updated = block_in_place(|| {
            self.store
                .update(
                    id,
                    ConnectionChanges {
                        name: connection.name,
                        service_type: ServiceType::parse(&connection.service_type),
                        endpoint: connection.endpoint,
                        credential_ref: connection.credential_ref,
                    },
                )
                .map_err(connection_to_api)
        })?;
        Ok(Self::to_dto(&updated))
    }

    async fn delete_connection(&self, id: &str) -> Result<(), ApiError> {
        block_in_place(|| self.store.delete(id).map_err(connection_to_api))
    }
}

// ---------------------------------------------------------------------------
// runs
// ---------------------------------------------------------------------------

fn reject_legacy_executor(kind: Option<&str>) -> Result<(), ApiError> {
    if kind.map(str::trim) == Some("runtime-acp") {
        return Err(ApiError::conflict("旧执行器 runtime-acp 需要迁移：请显式配置 pi 角色及其 Runtime 模型，为新运行绑定独立身份。旧快照不能改写或重放"));
    }
    Ok(())
}

/// [`RunsApi`] 的 runs 域适配器：变更入口走 Engine，读取走 RunRepository；
/// 创建运行时从 workflows/roles 一致读取定义与角色配置并冻结快照。
pub(crate) struct RunsApiAdapter {
    admission: Option<Arc<super::execution::ProductionRunner>>,
    engine: Arc<crate::runs::engine::Engine>,
    store: Arc<crate::runs::SqliteRunStore>,
    workflow_store: Arc<WorkflowStore>,
    roles_service: Arc<crate::roles::RoleService<super::gateways::RolesConnectionGateway>>,
}

impl RunsApiAdapter {
    pub(super) fn new(
        engine: Arc<crate::runs::engine::Engine>,
        store: Arc<crate::runs::SqliteRunStore>,
        workflow_store: Arc<WorkflowStore>,
        roles_service: Arc<crate::roles::RoleService<super::gateways::RolesConnectionGateway>>,
        admission: Option<Arc<super::execution::ProductionRunner>>,
    ) -> Self {
        Self { engine, store, workflow_store, roles_service, admission }
    }

    async fn admit(&self, id: &str) -> Result<(), ApiError> {
        let snapshot = self.store.get_snapshot(id).await
            .map_err(|e| storage_to_api(&e))?
            .ok_or_else(|| ApiError::not_found(format!("运行 {id}")))?;
        for role in snapshot.roles.values() {
            reject_legacy_executor(role["executorKind"].as_str())?;
        }
        if let Some(runner) = &self.admission {
            runner.admit(id, &snapshot.workflow).await?;
        }
        Ok(())
    }

    // 清理与执行分别提交。运行终态即使清理失败仍可被调用方读到。
    async fn finish(&self, id: &str) -> Result<RunDto, ApiError> {
        let run = self.load_dto(id).await?;
        if matches!(run.status.as_str(), "succeeded" | "cancelled" | "failed") {
            self.engine.release_resources(id).await.map_err(engine_to_api)?;
        }
        Ok(run)
    }

    async fn load_dto(&self, run_id: &str) -> Result<RunDto, ApiError> {
        let run = self
            .store
            .get_run(run_id)
            .await
            .map_err(|e| storage_to_api(&e))?
            .ok_or_else(|| ApiError::not_found(format!("运行 {run_id}")))?;
        Ok(RunDto::from_domain(&run))
    }
}

/// 收集流程定义引用的全部角色 ID（仅 agent 节点，去重保序）。
fn collect_role_ids(def: &WorkflowDefinition) -> Vec<String> {
    let mut ids = Vec::new();
    for node in &def.nodes {
        if node.node_type == NodeType::Agent {
            if let Some(role_id) = node.role_id.as_deref() {
                if !ids.iter().any(|id: &String| id == role_id) {
                    ids.push(role_id.to_string());
                }
            }
        }
    }
    ids
}

#[async_trait]
impl RunsApi for RunsApiAdapter {
    async fn create_run(&self, request: CreateRunRequest) -> Result<RunDto, ApiError> {
        let wf = block_in_place(|| {
            self.workflow_store
                .get(&request.workflow_id)
                .map_err(workflow_to_api)
        })?;
        // 冻结角色配置（runs SPEC「运行创建与配置冻结」）：逐角色导出
        // 可冻结聚合的 domain Role 投影。roles 缺失即创建失败（404），
        // 与 engine 的快照完整性校验语义一致。
        let mut frozen = serde_json::Map::new();
        for role_id in collect_role_ids(&wf) {
            let freezable = self
                .roles_service
                .export_freezable(&role_id)
                .await
                .map_err(roles_to_api)?;
            let def = freezable.definition;
            reject_legacy_executor(def.executor_kind.as_ref().map(|kind| kind.as_str()))?;
            let mut role = def.base;
            // Runtime v1 accepts text only. Freeze a single Markdown skill as text;
            // leave multi-file packages intact so the execution adapter rejects them.
            if def.executor_kind.as_ref().map(|k| k.as_str()) == Some("pi")
                && role.skills.as_slice() == [crate::roles::SKILL_ENTRY]
                && def.skill_package.files.len() == 1
            {
                let entry = def.skill_package.file(crate::roles::SKILL_ENTRY).ok_or(ApiError::Internal)?;
                let instructions = std::str::from_utf8(&entry.bytes).map_err(|_| ApiError::Internal)?;
                role.prompt.push_str("\n\nSKILL.md:\n");
                role.prompt.push_str(instructions);
                role.skills.clear();
            }
            if def.executor_kind.as_ref().map(|k| k.as_str()) == Some("pi") && !request.input.is_empty() {
                role.prompt.push_str("\n\n运行任务：\n");
                role.prompt.push_str(&request.input);
            }
            let mut role_json = serde_json::to_value(role).map_err(|_| ApiError::Internal)?;
            role_json["executorKind"] = serde_json::json!(def.executor_kind);
            frozen.insert(role_id, role_json);
        }
        let run = self
            .engine
            .create_run(&wf, &frozen)
            .await
            .map_err(engine_to_api)?;
        Ok(RunDto::from_domain(&run))
    }

    async fn start_run(&self, run_id: &str) -> Result<RunDto, ApiError> {
        self.admit(run_id).await?;
        self.engine.start_run(run_id).await.map_err(engine_to_api)?;
        self.finish(run_id).await
    }

    async fn approve(&self, run_id: &str, node_id: &str) -> Result<RunDto, ApiError> {
        self.admit(run_id).await?;
        self.engine
            .approve(run_id, node_id)
            .await
            .map_err(engine_to_api)?;
        self.finish(run_id).await
    }

    async fn reject(&self, run_id: &str, node_id: &str, target: &str) -> Result<RunDto, ApiError> {
        self.admit(run_id).await?;
        self.engine
            .reject(run_id, node_id, target)
            .await
            .map_err(engine_to_api)?;
        self.finish(run_id).await
    }

    async fn cancel_run(&self, run_id: &str) -> Result<RunDto, ApiError> {
        self.engine.cancel(run_id).await.map_err(engine_to_api)?;
        self.finish(run_id).await
    }

    async fn get_run(&self, run_id: &str) -> Result<RunDto, ApiError> {
        self.load_dto(run_id).await
    }

    async fn list_runs(&self) -> Result<Vec<RunDto>, ApiError> {
        let rows = self.store.list_runs(&[]).await.map_err(|e| storage_to_api(&e))?;
        let mut result = Vec::with_capacity(rows.len());
        for row in rows {
            result.push(self.load_dto(&row.id).await?);
        }
        Ok(result)
    }
}

// ---------------------------------------------------------------------------
// artifacts
// ---------------------------------------------------------------------------

/// 只投影已提交的归档记录；runs 的节点声明不证明内容存在。
pub(crate) struct ArtifactsApiAdapter {
    store: Arc<ArtifactStore>,
}

impl ArtifactsApiAdapter {
    pub(crate) fn new(store: Arc<ArtifactStore>) -> Self {
        Self { store }
    }

    fn to_dto(record: ArtifactRecord, content: Option<String>) -> Result<ArtifactDto, ApiError> {
        Ok(ArtifactDto {
            id: record.artifact_id,
            name: record.name,
            path: record.path,
            media_type: record.media_type,
            run_id: record.run_id,
            node_id: record.node_id,
            attempt: record.attempt.try_into().map_err(|_| ApiError::Internal)?,
            content,
        })
    }
}

#[async_trait]
impl ArtifactsApi for ArtifactsApiAdapter {
    async fn get_artifact(&self, artifact_id: &str) -> Result<ArtifactDto, ApiError> {
        let store = self.store.clone();
        let id = artifact_id.to_owned();
        let object = tokio::task::spawn_blocking(move || store.get(&id))
            .await
            .map_err(|_| ApiError::Internal)?
            .map_err(|err| match err {
                ArtifactError::NotFound(_) => ApiError::not_found("产物"),
                _ => ApiError::Internal,
            })?;
        // content 是可选文本，二进制不做有损替换。
        Self::to_dto(object.record, String::from_utf8(object.bytes).ok())
    }

    async fn list_artifacts(&self, run_id: Option<&str>) -> Result<Vec<ArtifactDto>, ApiError> {
        let store = self.store.clone();
        let run_id = run_id.map(str::to_owned);
        let records = tokio::task::spawn_blocking(move || match run_id {
            Some(id) => store.list(&id, None, None, None),
            None => store.list_all(),
        })
        .await
        .map_err(|_| ApiError::Internal)?
        .map_err(|_| ApiError::Internal)?;
        records.into_iter().map(|r| Self::to_dto(r, None)).collect()
    }
}

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

/// [`EventFeed`] 的 runs 适配器：历史重放事实来源是 RunRepository 的
/// 事件表，实时通知经 Engine 的 EventBus 订阅扇出到各 SSE 连接。
pub(crate) struct RunEventFeed {
    store: Arc<crate::runs::SqliteRunStore>,
    events: Arc<crate::runs::engine::EventBus>,
}

impl RunEventFeed {
    pub(crate) fn new(
        store: Arc<crate::runs::SqliteRunStore>,
        events: Arc<crate::runs::engine::EventBus>,
    ) -> Arc<Self> {
        Arc::new(Self { store, events })
    }
}

#[async_trait]
impl EventFeed for RunEventFeed {
    fn subscribe(&self, run_id: &str) -> EventStream {
        let mut broadcast = self.events.subscribe();
        let (tx, rx) = tokio::sync::mpsc::channel(64);
        let run_id = run_id.to_string();
        // 扇出任务：广播丢失（Lagged）只影响实时通知，SSE 侧回源补读
        // 不丢数据；run_id 不匹配的事件丢弃（广播是全局的）。
        tokio::spawn(async move {
            loop {
                match broadcast.recv().await {
                    Ok((owner, event)) => {
                        if owner == run_id {
                            let record = NumberedEvent {
                                run_id: run_id.clone(),
                                // 广播不携带持久序号；SSE 回源时以持久
                                // seq 为准，通知侧填 0 仅作唤醒信号。
                                seq: 0,
                                event,
                            };
                            if tx.send(record).await.is_err() {
                                break; // 客户端断开，释放订阅
                            }
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        });
        rx
    }

    async fn read_since(
        &self,
        run_id: &str,
        after_seq: u64,
    ) -> Result<Vec<NumberedEvent>, ApiError> {
        // 运行存在性检查：未知运行返回 NotFound（SSE 握手即失败）。
        let exists = self
            .store
            .get_run(run_id)
            .await
            .map_err(|e| storage_to_api(&e))?
            .is_some();
        if !exists {
            return Err(ApiError::not_found(format!("运行 {run_id}")));
        }
        let records = self
            .store
            .list_events_since(run_id, after_seq as i64)
            .await
            .map_err(|e| storage_to_api(&e))?;
        Ok(records
            .into_iter()
            .map(|r| NumberedEvent {
                run_id: r.run_id,
                seq: r.seq.max(0) as u64,
                event: r.event,
            })
            .collect())
    }
}
