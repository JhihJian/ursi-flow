//! ursi-flow 共享领域模型与契约层。
//!
//! 该 crate 拥有跨模块复用的类型定义、工作流结构定义与解析校验、
//! 运行状态机枚举、角色与能力定制模型、执行器与产物契约，以及观测事件契约。
//! 其他模块引用这里的类型，不各自定义等价结构。

pub mod artifact;
pub mod env;
pub mod role;
pub mod run;
pub mod telemetry;
pub mod workflow;

pub use artifact::Artifact;
pub use env::{EnvError, ExecutionEnv};
pub use role::{Executor, Role};
pub use run::{NodeRun, NodeStatus, Run, RunStatus};
pub use telemetry::{EventCategory, EventPhase, TelemetryEvent};
pub use workflow::{
    parse_workflow, validate_workflow, ArtifactContract, NodeType, Position, WorkflowDefinition,
    WorkflowEdge, WorkflowError, WorkflowNode,
};
