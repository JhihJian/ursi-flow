//! CliAdapter：Runner 契约的 CLI 实现，经 ExecutionEnv 在沙箱内完成
//! 渲染 → 启动 → 采集 → 清理的单次执行闭环。
//!
//! 流程（[`Runner::run`]）：
//! 1. 渲染会话工作区配置（含任务提示词覆盖）并 materialize；
//! 2. 按 argv 生成 `argv0 arg1 arg2 ...` 命令字符串，env.exec 执行；
//! 3. 从工作区读输出（stdout 为最终输出）与产物声明清单，构造 Artifact；
//! 4. 无论成败执行 cleanup（幂等），最后返回结果或错误。
//!
//! 失败语义：
//! - exec 非零退出 → `ExecutorError::Execution`，不自动重试；
//! - CLI 输出不含产物声明时的产物行为：声明文件缺失按无产物处理。
//!
//! Runner 接口为单次执行，没有会话取消入口。渲染只产出 `{{cred:...}}`
//! 占位清单，真实凭据由执行环境装配方提供，占位文件由 cleanup 删除。

use std::sync::Arc;

use async_trait::async_trait;
use ursi_agent_runtime::{EventSink, ExecutorError, InvocationInput, InvocationResult, Runner};
use ursi_domain::{ExecutionEnv, Executor, Role, TelemetryEvent};

use crate::capability::{
    self, ARTIFACTS_MANIFEST_FILE, CapabilityManifest, CliRenderPlan,
};

/// CLI 可把最终 stdout 同步写入的约定文件名。本 crate 以 env.exec 合并输出
/// 作为最终输出，该文件供装配方按需读取，CliAdapter 不主动读写。
pub const OUTPUT_CAPTURE_FILE: &str = ".ursi/session/stdout.txt";

/// 事件名：配置写入 / CLI 启动 / 产物采集 / 清理。
pub const EVT_RENDER: &str = "cli.render";
pub const EVT_LAUNCH: &str = "cli.launch";
pub const EVT_ARTIFACTS: &str = "cli.artifacts";
pub const EVT_CLEANUP: &str = "cli.cleanup";

/// CLI 执行器：经 ExecutionEnv 在沙箱内启动 CLI，采集输出与产物。
pub struct CliAdapter {
    manifest: CapabilityManifest,
}

impl CliAdapter {
    pub fn new(plan: Arc<dyn CliRenderPlan>) -> Self {
        Self {
            manifest: CapabilityManifest::new(plan),
        }
    }

    /// 使用通用渲染计划构造。
    pub fn generic() -> Self {
        Self {
            manifest: CapabilityManifest::generic(),
        }
    }

    /// 单次执行（独立函数，供装配方以任意 env 调用）。
    ///
    /// Runner::run 经由本函数完成实际工作；`sink` 可为空实现。
    pub async fn execute(
        &self,
        input: &InvocationInput,
        role: &Role,
        executor: &Executor,
        env: &dyn ExecutionEnv,
        sink: EventSink<'_>,
    ) -> Result<InvocationResult, ExecutorError> {
        let outcome = self
            .manifest
            .render(role, executor, &workspace_root(env))
            .map_err(launch_err)?;

        // 任务提示词覆盖角色基础提示词：prompt 为空时保留角色 prompt。
        let mut outcome = outcome;
        if !input.prompt.trim().is_empty() {
            outcome
                .overwrite_file(capability::PROMPT_FILE, input.prompt.clone().into_bytes())
                .map_err(launch_err)?;
        }
        emit(sink, EVT_RENDER, "会话工作区配置已写入", &[
            ("files", outcome.files().len().into()),
        ]);

        capability::materialize(env, &outcome)
            .await
            .map_err(launch_err)?;

        if outcome.argv().is_empty() {
            return Err(ExecutorError::Launch(
                "执行器类型为 Mock，CLI 适配器不适用；mock 请使用 StubAdapter".to_string(),
            ));
        }

        // argv 逐项 shell 转义后空格拼接，作为单条命令经 env.exec 执行。
        let cmd = outcome
            .argv()
            .iter()
            .map(|a| capability::shell_quote(a))
            .collect::<Vec<_>>()
            .join(" ");
        emit(sink, EVT_LAUNCH, "CLI 启动", &[("argv", cmd.clone().into())]);
        let (code, output) = env
            .exec(&cmd)
            .await
            .map_err(|e| ExecutorError::Launch(format!("命令启动失败：{e}")))?;

        let result = if code != 0 {
            // 失败不自动重试：直接报告失败，由上层决定重试策略。
            Err(ExecutorError::Execution(format!("退出码 {code}")))
        } else {
            let artifacts = collect_artifacts(env).await?;
            emit(
                sink,
                EVT_ARTIFACTS,
                "产物采集完成",
                &[("count", artifacts.len().into())],
            );
            Ok(InvocationResult {
                output,
                artifacts,
                tokens: 0,
            })
        };

        // 无论成败都清理渲染文件与临时凭据占位文件。
        match capability::cleanup(env, &outcome).await {
            Ok(()) => {}
            Err(e) => emit(sink, EVT_CLEANUP, "清理失败", &[("error", e.to_string().into())]),
        }
        result
    }
}

#[async_trait]
impl Runner for CliAdapter {
    async fn run(
        &self,
        input: &InvocationInput,
        role: &Role,
        executor: &Executor,
        env: Arc<dyn ExecutionEnv>,
        sink: EventSink<'_>,
    ) -> Result<InvocationResult, ExecutorError> {
        self.execute(input, role, executor, env.as_ref(), sink).await
    }
}

/// workspace 根：ExecutionEnv 以根目录为基准解析相对路径，这里用固定
/// 标识占位（渲染只把根写进 config 的 workspaceRoot 字段，供 CLI 读取）。
fn workspace_root(env: &dyn ExecutionEnv) -> String {
    let _ = env;
    "/ursi/workspace/session".to_string()
}

/// 从工作区读取产物声明清单，逐项读取文件构造 Artifact。
/// 声明文件缺失视为无产物；声明的产物文件缺失返回 Parse 错误。
async fn collect_artifacts(env: &dyn ExecutionEnv) -> Result<Vec<ursi_domain::Artifact>, ExecutorError> {
    let bytes = match env.read_file(ARTIFACTS_MANIFEST_FILE).await {
        Ok(bytes) => bytes,
        Err(ursi_domain::EnvError::FileNotFound(_)) => return Ok(Vec::new()),
        Err(e) => return Err(ExecutorError::Parse(format!("读取产物清单失败：{e}"))),
    };
    let manifest: Vec<ManifestEntry> = serde_json::from_slice(&bytes)
        .map_err(|e| ExecutorError::Parse(format!("解析产物清单失败：{e}")))?;
    let mut artifacts = Vec::new();
    for entry in manifest {
        let bytes = env.read_file(&entry.path).await.map_err(|e| {
            ExecutorError::Parse(format!("读取产物 {} 失败：{e}", entry.path))
        })?;
        if bytes.is_empty() {
            return Err(ExecutorError::Parse(format!(
                "产物 {} 内容为空",
                entry.path
            )));
        }
        artifacts.push(ursi_domain::Artifact {
            id: format!("art-{}", entry.name),
            name: entry.name,
            path: entry.path,
            required: false,
            media_type: entry.media_type,
        });
    }
    Ok(artifacts)
}

#[derive(serde::Deserialize)]
struct ManifestEntry {
    name: String,
    path: String,
    #[serde(default)]
    media_type: Option<String>,
}

fn launch_err(e: capability::RenderError) -> ExecutorError {
    match e {
        capability::RenderError::Env(msg) => ExecutorError::Execution(msg),
        _ => ExecutorError::Launch(e.to_string()),
    }
}

fn emit(sink: EventSink<'_>, name: &str, message: &str, attrs: &[(&str, serde_json::Value)]) {
    let mut attributes = std::collections::HashMap::new();
    for (k, v) in attrs {
        attributes.insert((*k).to_string(), v.clone());
    }
    sink(TelemetryEvent {
        category: ursi_domain::EventCategory::Tool,
        name: name.to_string(),
        phase: ursi_domain::EventPhase::Progress,
        message: message.to_string(),
        attributes,
    });
}

/// mock 执行器：与 agent-runtime::MockRunner 对齐的本地确定性 mock。
///
/// 用于 Flow 流程测试，忽略 ExecutionEnv，通过输入构造结果或模拟失败。
pub struct StubAdapter;

#[async_trait]
impl Runner for StubAdapter {
    async fn run(
        &self,
        input: &InvocationInput,
        _role: &Role,
        _executor: &Executor,
        _env: Arc<dyn ExecutionEnv>,
        sink: EventSink<'_>,
    ) -> Result<InvocationResult, ExecutorError> {
        let _ = sink;
        self.execute(input).await
    }
}

impl StubAdapter {
    /// 确定性执行：回显提示词与产物上下文；`失败:` 前缀模拟执行失败，
    /// `产物:` 行声明产物（与 CliAdapter 的产物清单约定不同的简化形态，
    /// 供流程测试断言）。
    pub async fn execute(
        &self,
        input: &InvocationInput,
    ) -> Result<InvocationResult, ExecutorError> {
        if let Some(reason) = input.prompt.strip_prefix("失败:") {
            return Err(ExecutorError::Execution(reason.trim().to_string()));
        }
        let mut output = input.prompt.clone();
        if !input.artifact_context.is_empty() {
            output.push_str("\n");
            output.push_str(&input.artifact_context);
        }
        let artifacts = output
            .lines()
            .filter_map(|line| line.strip_prefix("产物:"))
            .map(|p| {
                let p = p.trim();
                (
                    p,
                    p.rsplit('/').next().unwrap_or(p),
                )
            })
            .map(|(path, name)| ursi_domain::Artifact {
                id: format!("art-{name}"),
                name: name.to_string(),
                path: path.to_string(),
                required: false,
                media_type: Some("text/plain".to_string()),
            })
            .collect();
        Ok(InvocationResult {
            output,
            artifacts,
            tokens: 0,
        })
    }
}
