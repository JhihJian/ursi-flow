//! Flow 的 CLI Runner：渲染角色能力，经 ExecutionEnv 执行并回传产物和事件。
//! [`StubAdapter`] 和 [`local_env`] 用于本地验证。
mod adapter;
pub mod capability;
pub mod local_env;

pub use adapter::{
    CliAdapter, StubAdapter, EVT_ARTIFACTS, EVT_CLEANUP, EVT_LAUNCH, EVT_RENDER,
    OUTPUT_CAPTURE_FILE,
};
pub use capability::{
    CapabilityManifest, CliRenderPlan, GenericCliPlan, PlannedCli, RenderContext, RenderError,
    RenderOutcome,
};
