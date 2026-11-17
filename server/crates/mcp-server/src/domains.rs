//! 工具注册域骨架：运维域、控制域、内部工具域。
//!
//! 每个域用注入的 backend 生成自己的工具，域操作不直接实现业务。
//! `Domain` 是三域的统一实现入口，`DomainId` 是装配时的域选择标识。

use crate::backend::{ControlBackend, InternalBackend, InternalBackendError, OpsBackend};
use crate::context::InvocationContext;
use crate::error::ToolError;
use crate::tool::{fn_handler, Tool, ToolOutput};
use serde_json::{json, Value};
use std::sync::Arc;

/// server 装配时选择暴露的域标识。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DomainId {
    Ops,
    Control,
    Internal,
}

impl DomainId {
    /// 全部域，供 `register_domain(&DomainId::ALL)` 使用。
    pub const ALL: [DomainId; 3] = [DomainId::Ops, DomainId::Control, DomainId::Internal];

    pub fn name(self) -> &'static str {
        match self {
            DomainId::Ops => "ops",
            DomainId::Control => "control",
            DomainId::Internal => "internal",
        }
    }
}

impl std::fmt::Display for DomainId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.name())
    }
}

/// 工具注册域：backend 决定域的能力集，域操作不实现业务。
#[derive(Clone)]
pub enum Domain {
    /// 运维域：沙箱与网关操作。
    Ops(Arc<dyn OpsBackend>),
    /// 控制域：流程与运行操作。
    Control(Arc<dyn ControlBackend>),
    /// 内部工具域：运行上下文内的产物与状态工具。
    Internal(Arc<dyn InternalBackend>),
}

impl std::fmt::Debug for Domain {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Domain::Ops(_) => write!(f, "Domain::Ops"),
            Domain::Control(_) => write!(f, "Domain::Control"),
            Domain::Internal(_) => write!(f, "Domain::Internal"),
        }
    }
}

impl Domain {
    /// 域对应的装配标识。
    pub fn id(&self) -> DomainId {
        match self {
            Domain::Ops(_) => DomainId::Ops,
            Domain::Control(_) => DomainId::Control,
            Domain::Internal(_) => DomainId::Internal,
        }
    }

    /// 域名标识，同 [`DomainId::name`]。
    pub fn name(&self) -> &'static str {
        self.id().name()
    }

    /// 域的全部工具。server 装配时从各域收集，调用时按名路由回域处理。
    pub fn tools(&self) -> Vec<Tool> {
        match self {
            Domain::Ops(backend) => ops_tools(backend.clone()),
            Domain::Control(backend) => control_tools(backend.clone()),
            Domain::Internal(backend) => internal_tools(backend.clone()),
        }
    }

    /// 按名调用域内工具。路由正确性由 `McpServer` 的注册表保证。
    ///
    /// 内部域工具从 `ctx` 取身份，ctx 为占位时返回缺失上下文错误；
    /// 运维域与控制域不读取身份，占位上下文即可调用。
    pub async fn invoke(
        &self,
        name: &str,
        ctx: &InvocationContext,
        args: Value,
    ) -> Result<ToolOutput, ToolError> {
        for tool in self.tools() {
            if tool.name == name {
                return tool.handler.invoke(ctx, args).await;
            }
        }
        Err(ToolError::UnknownTool {
            name: name.to_string(),
        })
    }
}

// 工具名常量：带域前缀，server 内全局唯一。
const OPS_LIST: &str = "ops_list_sandboxes";
const OPS_GET_SANDBOX: &str = "ops_get_sandbox";
const OPS_RESTART: &str = "ops_restart_sandbox";
const OPS_STOP: &str = "ops_stop_sandbox";
const OPS_GATEWAY_STATUS: &str = "ops_gateway_status";
const CONTROL_GET_RUN: &str = "control_get_run";
const CONTROL_LIST: &str = "control_list_runs";
const CONTROL_CANCEL: &str = "control_cancel_run";
const CONTROL_APPROVE: &str = "control_approve";
const INTERNAL_STATUS: &str = "internal_get_run_status";
const INTERNAL_LIST_NODES: &str = "internal_list_nodes";
const INTERNAL_GET_ARTIFACT: &str = "internal_get_artifact";
const INTERNAL_LIST_ARTIFACTS: &str = "internal_list_artifacts";

// ---------- 运维域 ----------

fn ops_tools(backend: Arc<dyn OpsBackend>) -> Vec<Tool> {
    let list = {
        let backend = Arc::clone(&backend);
        fn_handler(move |_ctx, args| {
            let backend = Arc::clone(&backend);
            Box::pin(async move {
                let run_id = args.get("run_id").and_then(|v| v.as_str()).map(String::from);
                backend
                    .list_sandboxes(run_id.as_deref())
                    .await
                    .map(views_output)
                    .map_err(|e| execution(OPS_LIST, e.message))
            })
        })
    };
    let get_sandbox = {
        let backend = Arc::clone(&backend);
        fn_handler(move |_ctx, args| {
            let backend = Arc::clone(&backend);
            Box::pin(async move {
                let sandbox_id = require_string(&args, "sandbox_id", OPS_GET_SANDBOX)?;
                backend
                    .get_sandbox(&sandbox_id)
                    .await
                    .map(|s| view_output(&s))
                    .map_err(|e| execution(OPS_GET_SANDBOX, e.message))
            })
        })
    };
    let restart = {
        let backend = Arc::clone(&backend);
        fn_handler(move |_ctx, args| {
            let backend = Arc::clone(&backend);
            Box::pin(async move {
                let sandbox_id = require_string(&args, "sandbox_id", OPS_RESTART)?;
                backend
                    .restart_sandbox(&sandbox_id)
                    .await
                    .map(outcome_output)
                    .map_err(|e| execution(OPS_RESTART, e.message))
            })
        })
    };
    let stop = {
        let backend = Arc::clone(&backend);
        fn_handler(move |_ctx, args| {
            let backend = Arc::clone(&backend);
            Box::pin(async move {
                let sandbox_id = require_string(&args, "sandbox_id", OPS_STOP)?;
                backend
                    .stop_sandbox(&sandbox_id)
                    .await
                    .map(outcome_output)
                    .map_err(|e| execution(OPS_STOP, e.message))
            })
        })
    };
    let gateway = {
        let backend = Arc::clone(&backend);
        fn_handler(move |_ctx, _args| {
            let backend = Arc::clone(&backend);
            Box::pin(async move {
                backend
                    .gateway_status()
                    .await
                    .map(|s| view_output(&s))
                    .map_err(|e| execution(OPS_GATEWAY_STATUS, e.message))
            })
        })
    };
    vec![
        Tool::new(
            OPS_LIST,
            "列出沙箱，可按归属运行过滤。",
            json!({
                "type": "object",
                "properties": {
                    "run_id": { "type": "string", "description": "可选，按归属运行过滤" }
                }
            }),
            list,
        ),
        Tool::new(
            OPS_GET_SANDBOX,
            "按 ID 查询沙箱状态与归属。",
            json!({
                "type": "object",
                "required": ["sandbox_id"],
                "properties": { "sandbox_id": { "type": "string" } }
            }),
            get_sandbox,
        ),
        Tool::new(
            OPS_RESTART,
            "重启沙箱（幂等）。",
            json!({
                "type": "object",
                "required": ["sandbox_id"],
                "properties": { "sandbox_id": { "type": "string" } }
            }),
            restart,
        ),
        Tool::new(
            OPS_STOP,
            "停止沙箱（幂等）。",
            json!({
                "type": "object",
                "required": ["sandbox_id"],
                "properties": { "sandbox_id": { "type": "string" } }
            }),
            stop,
        ),
        Tool::new(
            OPS_GATEWAY_STATUS,
            "查询网关运行状态。",
            json!({ "type": "object", "properties": {} }),
            gateway,
        ),
    ]
}

// ---------- 控制域 ----------

fn control_tools(backend: Arc<dyn ControlBackend>) -> Vec<Tool> {
    let get_run = {
        let backend = Arc::clone(&backend);
        fn_handler(move |_ctx, args| {
            let backend = Arc::clone(&backend);
            Box::pin(async move {
                let run_id = require_string(&args, "run_id", CONTROL_GET_RUN)?;
                backend
                    .get_run(&run_id)
                    .await
                    .map(|r| view_output(&r))
                    .map_err(|e| execution(CONTROL_GET_RUN, e.message))
            })
        })
    };
    let list_runs = {
        let backend = Arc::clone(&backend);
        fn_handler(move |_ctx, args| {
            let backend = Arc::clone(&backend);
            Box::pin(async move {
                let status = args.get("status").and_then(|v| v.as_str()).map(String::from);
                backend
                    .list_runs(status.as_deref())
                    .await
                    .map(views_output)
                    .map_err(|e| execution(CONTROL_LIST, e.message))
            })
        })
    };
    let cancel = {
        let backend = Arc::clone(&backend);
        fn_handler(move |_ctx, args| {
            let backend = Arc::clone(&backend);
            Box::pin(async move {
                let run_id = require_string(&args, "run_id", CONTROL_CANCEL)?;
                backend
                    .cancel_run(&run_id)
                    .await
                    .map(outcome_output)
                    .map_err(|e| execution(CONTROL_CANCEL, e.message))
            })
        })
    };
    let approve = {
        let backend = Arc::clone(&backend);
        fn_handler(move |_ctx, args| {
            let backend = Arc::clone(&backend);
            Box::pin(async move {
                let run_id = require_string(&args, "run_id", CONTROL_APPROVE)?;
                let node_id = require_string(&args, "node_id", CONTROL_APPROVE)?;
                let approved = require_bool(&args, "approved", CONTROL_APPROVE)?;
                backend
                    .approve(&run_id, &node_id, approved)
                    .await
                    .map(outcome_output)
                    .map_err(|e| execution(CONTROL_APPROVE, e.message))
            })
        })
    };
    vec![
        Tool::new(
            CONTROL_GET_RUN,
            "按运行 ID 查询运行状态摘要。",
            json!({
                "type": "object",
                "required": ["run_id"],
                "properties": { "run_id": { "type": "string" } }
            }),
            get_run,
        ),
        Tool::new(
            CONTROL_LIST,
            "列出运行，可按状态过滤。",
            json!({
                "type": "object",
                "properties": {
                    "status": {
                        "type": "string",
                        "description": "可选：queued/running/waiting/succeeded/failed/cancelled"
                    }
                }
            }),
            list_runs,
        ),
        Tool::new(
            CONTROL_CANCEL,
            "取消运行（幂等）。",
            json!({
                "type": "object",
                "required": ["run_id"],
                "properties": { "run_id": { "type": "string" } }
            }),
            cancel,
        ),
        Tool::new(
            CONTROL_APPROVE,
            "审批运行中等待确认的节点。",
            json!({
                "type": "object",
                "required": ["run_id", "node_id", "approved"],
                "properties": {
                    "run_id": { "type": "string" },
                    "node_id": { "type": "string" },
                    "approved": { "type": "boolean" }
                }
            }),
            approve,
        ),
    ]
}

// ---------- 内部工具域 ----------

fn internal_tools(backend: Arc<dyn InternalBackend>) -> Vec<Tool> {
    let status = {
        let backend = Arc::clone(&backend);
        fn_handler(move |ctx, _args| {
            let backend = Arc::clone(&backend);
            Box::pin(async move {
                let run_id = ctx_run_id(ctx)?;
                backend
                    .get_run_status(&run_id)
                    .await
                    .map(|r| view_output(&r))
                    .map_err(|e| internal_execution(INTERNAL_STATUS, e))
            })
        })
    };
    let list_nodes = {
        let backend = Arc::clone(&backend);
        fn_handler(move |ctx, _args| {
            let backend = Arc::clone(&backend);
            Box::pin(async move {
                let run_id = ctx_run_id(ctx)?;
                backend
                    .list_nodes(&run_id)
                    .await
                    .map(views_output)
                    .map_err(|e| internal_execution(INTERNAL_LIST_NODES, e))
            })
        })
    };
    let get_artifact = {
        let backend = Arc::clone(&backend);
        fn_handler(move |ctx, args| {
            let backend = Arc::clone(&backend);
            Box::pin(async move {
                let run_id = ctx_run_id(ctx)?;
                let artifact_id = require_string(&args, "artifact_id", INTERNAL_GET_ARTIFACT)?;
                let artifact = backend
                    .get_artifact(&run_id, &artifact_id)
                    .await
                    .map_err(|e| match e {
                        InternalBackendError::CrossRun {
                            owner_run,
                            context_run,
                            ..
                        } => ToolError::CrossRunAccess {
                            resource: artifact_id.clone(),
                            owner_run,
                            context_run,
                        },
                        other => internal_execution(INTERNAL_GET_ARTIFACT, other),
                    })?;
                // 纵深防御：backend 未拦住的越权在工具层兜底拒绝。
                if artifact.owner_run_id != run_id {
                    return Err(ToolError::CrossRunAccess {
                        resource: artifact_id,
                        owner_run: artifact.owner_run_id,
                        context_run: run_id,
                    });
                }
                Ok(view_output(&artifact))
            })
        })
    };
    let list_artifacts = {
        let backend = Arc::clone(&backend);
        fn_handler(move |ctx, _args| {
            let backend = Arc::clone(&backend);
            Box::pin(async move {
                let run_id = ctx_run_id(ctx)?;
                backend
                    .list_artifacts(&run_id)
                    .await
                    .map(views_output)
                    .map_err(|e| internal_execution(INTERNAL_LIST_ARTIFACTS, e))
            })
        })
    };
    vec![
        Tool::new(
            INTERNAL_STATUS,
            "查询当前运行的状态摘要。身份从调用上下文注入。",
            json!({ "type": "object", "properties": {} }),
            status,
        ),
        Tool::new(
            INTERNAL_LIST_NODES,
            "列出当前运行的节点状态与产物概况。身份从调用上下文注入。",
            json!({ "type": "object", "properties": {} }),
            list_nodes,
        ),
        Tool::new(
            INTERNAL_GET_ARTIFACT,
            "按 ID 查询当前运行的产物元数据，只能访问上下文所属运行的产物。",
            json!({
                "type": "object",
                "required": ["artifact_id"],
                "properties": { "artifact_id": { "type": "string" } }
            }),
            get_artifact,
        ),
        Tool::new(
            INTERNAL_LIST_ARTIFACTS,
            "列出当前运行的产物。身份从调用上下文注入。",
            json!({ "type": "object", "properties": {} }),
            list_artifacts,
        ),
    ]
}

// ---------- 共用小工具 ----------

/// 内部域工具取身份：ctx 缺失（占位）即明确报错。
fn ctx_run_id(ctx: &InvocationContext) -> Result<String, ToolError> {
    if ctx.run_id.is_empty() {
        return Err(ToolError::MissingInvocationContext);
    }
    Ok(ctx.run_id.clone())
}

fn internal_execution(tool: &'static str, err: InternalBackendError) -> ToolError {
    ToolError::Execution {
        tool: tool.into(),
        message: err.to_string(),
    }
}

fn execution(tool: &'static str, message: String) -> ToolError {
    ToolError::Execution {
        tool: tool.into(),
        message,
    }
}

fn require_string(
    args: &serde_json::Value,
    key: &str,
    tool: &'static str,
) -> Result<String, ToolError> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(String::from)
        .ok_or_else(|| ToolError::InvalidArgs {
            tool: tool.into(),
            message: format!("缺少必填字符串参数 {key}"),
        })
}

fn require_bool(args: &serde_json::Value, key: &str, tool: &'static str) -> Result<bool, ToolError> {
    args.get(key)
        .and_then(|v| v.as_bool())
        .ok_or_else(|| ToolError::InvalidArgs {
            tool: tool.into(),
            message: format!("缺少必填布尔参数 {key}"),
        })
}

fn view_output<T: serde::Serialize>(value: &T) -> ToolOutput {
    serde_json::to_value(value).unwrap_or_default()
}

fn views_output<T: serde::Serialize>(values: Vec<T>) -> ToolOutput {
    serde_json::to_value(&values).unwrap_or_default()
}

/// 变更结果统一形态：{"changed": bool}
fn outcome_output(changed: bool) -> ToolOutput {
    json!({ "changed": changed })
}
