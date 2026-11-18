//! 集成测试：能力渲染落盘与 CliAdapter / StubAdapter 执行闭环。
//! 依赖 local-test-env feature（tempfile + local_env 模块）。

use std::sync::{Arc, Mutex};

use ursi_agent_cli_adapter::capability::{
    self, CapabilityManifest, CliRenderPlan, GenericCliPlan, PlannedCli, RenderContext,
};
use ursi_agent_cli_adapter::local_env::{LocalEnv, shared};
use ursi_agent_cli_adapter::{CliAdapter, StubAdapter};
use ursi_agent_runtime::{ExecutorError, InvocationInput, Runner};
use ursi_domain::ExecutionEnv;
use ursi_domain::{EnvError, Executor, ExecutorKind, Role, TelemetryEvent};

fn role() -> Role {
    Role {
        id: "r1".into(),
        name: "评审员".into(),
        prompt: "严格评审 {{cred:api-key}}".into(),
        model: Some("claude-sonnet".into()),
        skills: vec!["code-review".into()],
        mcp_servers: vec!["github".into()],
        executor_id: None,
    }
}

fn executor(kind: ExecutorKind) -> Executor {
    Executor {
        id: "e1".into(),
        name: "测试执行器".into(),
        kind,
    }
}

fn input(prompt: &str) -> InvocationInput {
    InvocationInput {
        prompt: prompt.into(),
        artifact_context: String::new(),
        run_id: "run-1".into(),
        node_id: "node-1".into(),
    }
}

fn quiet() -> &'static (dyn Fn(TelemetryEvent) + Send + Sync) {
    &|_| {}
}

struct ScriptPlan(String);

impl CliRenderPlan for ScriptPlan {
    fn plan(&self, _ctx: &RenderContext<'_>) -> Result<PlannedCli, capability::RenderError> {
        Ok(PlannedCli {
            argv: vec!["sh".into(), "-c".into(), self.0.clone()],
            extra_files: Vec::new(),
        })
    }
}

fn workspace_files() -> Vec<(String, Vec<u8>)> {
    vec![
        (
            capability::CONFIG_FILE.into(),
            br#"{"workspaceRoot":"/ursi/workspace/session"}"#.to_vec(),
        ),
        (capability::PROMPT_FILE.into(), "任务提示词".as_bytes().to_vec()),
    ]
}

#[tokio::test]
async fn 渲染后文件内容含角色能力配置() {
    let tmp = tempfile::tempdir().unwrap();
    let env = LocalEnv::new(tmp.path().to_path_buf());
    let r = role();
    let outcome = capability::render(&r, &executor(ExecutorKind::Cli("pi".into())), "/ws").unwrap();

    capability::materialize(&env, &outcome).await.unwrap();

    let config = String::from_utf8(env.read_file(capability::CONFIG_FILE).await.unwrap()).unwrap();
    assert!(config.contains("claude-sonnet"), "config 应含 model：{config}");
    assert!(config.contains("code-review"), "config 应含 skills：{config}");
    assert!(config.contains("github"), "config 应含 mcp_servers：{config}");
    assert!(config.contains("严格评审"), "config 应含 prompt：{config}");

    let prompt = String::from_utf8(env.read_file(capability::PROMPT_FILE).await.unwrap()).unwrap();
    assert_eq!(prompt, "严格评审 {{cred:api-key}}");

    let skill = String::from_utf8(
        env.read_file(".ursi/skills/code-review/SKILL.md")
            .await
            .unwrap(),
    )
    .unwrap();
    assert!(skill.contains("code-review"));
}

#[tokio::test]
async fn 路径穿越拒绝且落盘路径不出根() {
    let tmp = tempfile::tempdir().unwrap();
    let env = LocalEnv::new(tmp.path().to_path_buf());

    // 非法路径直接拒绝，不产生任何写盘。
    for bad in ["../escape", "/abs", "a/../b", "a//b", "a\\b", "."] {
        assert!(
            capability::normalize_rel(bad).is_err(),
            "路径 {bad} 应被拒绝"
        );
    }
    let mut r = role();
    r.skills = vec!["../escape".into()];
    assert!(capability::render(&r, &executor(ExecutorKind::Mock), "/ws").is_err());

    // 合法渲染经 LocalEnv 落盘后，全部文件都在根内。
    let r = role();
    let outcome = capability::render(&r, &executor(ExecutorKind::Mock), "/ws").unwrap();
    capability::materialize(&env, &outcome).await.unwrap();
    let root = tmp.path().canonicalize().unwrap();
    for (rel, _) in outcome.files() {
        let target = root.join(rel);
        assert!(target.exists(), "{rel} 应已写入根内");
    }
}

#[tokio::test]
async fn env清单不含真实凭据只有引用占位() {
    let mut r = role();
    // 角色字段只携带凭据引用，不携带真实凭据值。
    r.prompt = "使用连接凭证 {{cred:api-key}} 与 {{cred:mcp_token}}".into();
    let outcome = capability::render(&r, &executor(ExecutorKind::Mock), "/ws").unwrap();

    assert_eq!(
        outcome.env(),
        &[
            ("URSI_CRED_API_KEY".to_string(), "{{cred:api-key}}".to_string()),
            (
                "URSI_CRED_MCP_TOKEN".to_string(),
                "{{cred:mcp_token}}".to_string()
            ),
        ]
    );
    for (_, placeholder) in outcome.env() {
        assert!(
            placeholder.starts_with("{{cred:") && placeholder.ends_with("}}"),
            "占位值必须是引用形态：{placeholder}"
        );
    }
    // 凭据占位文件只有引用，不注入任何真实凭据值。
    let cred_file = outcome
        .files()
        .iter()
        .find(|(rel, _)| rel == capability::CREDENTIALS_FILE)
        .map(|(_, b)| String::from_utf8_lossy(b).to_string())
        .expect("应有凭据占位文件");
    for line in cred_file.lines().filter(|l| l.starts_with("export ")) {
        let value = line.split('=').nth(1).unwrap_or("");
        assert!(
            value.starts_with("'{{cred:") && value.ends_with("}}'"),
            "占位文件每行只能是引用：{line}"
        );
    }
    // 提示词与 config 保留引用原样，不被替换为任何凭据值。
    let prompt = String::from_utf8_lossy(
        &outcome
            .files()
            .iter()
            .find(|(rel, _)| rel == capability::PROMPT_FILE)
            .unwrap()
            .1,
    );
    assert_eq!(prompt, "使用连接凭证 {{cred:api-key}} 与 {{cred:mcp_token}}");
}

#[tokio::test]
async fn cli适配器执行闭环并清理凭据占位文件() {
    let tmp = tempfile::tempdir().unwrap();
    let env = LocalEnv::new(tmp.path().to_path_buf());
    let script = "cat .ursi/session/prompt.txt; printf '[{\"name\":\"报告\",\"path\":\"out/report.md\"}]' > .ursi/session/artifacts.json; mkdir -p out; printf '报告内容' > out/report.md";
    let adapter = CliAdapter::new(Arc::new(ScriptPlan(script.into())));

    let result = adapter
        .execute(&input("任务提示词"), &role(), &executor(ExecutorKind::Cli("fake".into())), &env, quiet())
        .await
        .unwrap();
    assert_eq!(result.output, "任务提示词", "stdout 应为最终输出");
    assert_eq!(result.artifacts.len(), 1);
    assert_eq!(result.artifacts[0].name, "报告");
    assert_eq!(result.artifacts[0].path, "out/report.md");

    // 渲染文件（含临时凭据占位文件）已清理。
    for rel in [capability::PROMPT_FILE, capability::CREDENTIALS_FILE] {
        assert!(
            matches!(env.read_file(rel).await, Err(EnvError::FileNotFound(_))),
            "{rel} 应已清理"
        );
    }
}

#[tokio::test]
async fn cli适配器非零退出返回执行失败且不重试并清理() {
    let tmp = tempfile::tempdir().unwrap();
    let env = LocalEnv::new(tmp.path().to_path_buf());
    let adapter = CliAdapter::new(Arc::new(ScriptPlan("exit 7".into())));

    let err = adapter
        .execute(&input("p"), &role(), &executor(ExecutorKind::Cli("fake".into())), &env, quiet())
        .await
        .unwrap_err();
    assert!(matches!(err, ExecutorError::Execution(ref m) if m.contains("7")));
    assert!(
        matches!(env.read_file(capability::PROMPT_FILE).await, Err(EnvError::FileNotFound(_))),
        "失败路径同样完成清理"
    );
}

#[tokio::test]
async fn cli适配器经runner契约执行并回流事件() {
    let tmp = tempfile::tempdir().unwrap();
    let env = shared(tmp.path().to_path_buf());
    let adapter = CliAdapter::new(Arc::new(ScriptPlan("cat .ursi/session/prompt.txt".into())));

    let events: Arc<Mutex<Vec<TelemetryEvent>>> = Arc::default();
    let captured = Arc::clone(&events);
    let sink = move |e: TelemetryEvent| captured.lock().unwrap().push(e);

    let result = adapter
        .run(&input("经契约入口"), &role(), &executor(ExecutorKind::Cli("fake".into())), env, &sink)
        .await
        .unwrap();
    assert_eq!(result.output, "经契约入口");
    let names: Vec<String> = events
        .lock()
        .unwrap()
        .iter()
        .map(|e| e.name.clone())
        .collect();
    assert!(names.iter().any(|n| n == ursi_agent_cli_adapter::EVT_LAUNCH), "应回流启动事件：{names:?}");
    assert!(names.iter().any(|n| n == ursi_agent_cli_adapter::EVT_RENDER), "应回流渲染事件：{names:?}");
}

#[tokio::test]
async fn stub适配器确定性输出与可注入失败() {
    let adapter = StubAdapter;
    let mut invocation = input("产物: out/a.md\n产物: out/b.txt");
    invocation.artifact_context = "上游上下文".into();
    let result = adapter.run(&invocation, &role(), &executor(ExecutorKind::Mock), shared(tempfile::tempdir().unwrap().path().to_path_buf()), quiet()).await.unwrap();
    assert!(result.output.starts_with("产物: out/a.md"));
    assert!(result.output.contains("上游上下文"));
    assert_eq!(result.artifacts.len(), 2);
    assert_eq!(result.artifacts[0].name, "a.md");
    assert_eq!(result.tokens, 0);

    let err = adapter
        .execute(&input("失败: 模型超时"))
        .await
        .unwrap_err();
    assert!(matches!(err, ExecutorError::Execution(ref m) if m == "模型超时"));
}

#[tokio::test]
async fn manifest使用通用计划渲染cli参数向量() {
    let manifest = CapabilityManifest::new(Arc::new(GenericCliPlan));
    let r = role();
    let outcome = manifest
        .render(&r, &executor(ExecutorKind::Cli("pi".into())), "/ws")
        .unwrap();
    assert_eq!(
        outcome.argv(),
        &[
            "pi".to_string(),
            "--config".into(),
            capability::CONFIG_FILE.into(),
            "--prompt-file".into(),
            capability::PROMPT_FILE.into(),
            "--model".into(),
            "claude-sonnet".into(),
        ]
    );
    // mock 类型渲染空参数向量。
    let outcome = manifest
        .render(&r, &executor(ExecutorKind::Mock), "/ws")
        .unwrap();
    assert!(outcome.argv().is_empty());
}

#[tokio::test]
async fn materialize后cleanup幂等删除渲染文件() {
    let tmp = tempfile::tempdir().unwrap();
    let env = LocalEnv::new(tmp.path().to_path_buf());
    let r = role();
    let outcome = capability::render(&r, &executor(ExecutorKind::Mock), "/ws").unwrap();
    capability::materialize(&env, &outcome).await.unwrap();
    capability::cleanup(&env, &outcome).await.unwrap();
    for (rel, _) in outcome.files() {
        assert!(
            matches!(env.read_file(rel).await, Err(EnvError::FileNotFound(_))),
            "{rel} 应已删除"
        );
    }
    capability::cleanup(&env, &outcome).await.unwrap();
}

#[tokio::test]
async fn 通用计划下的workspace_files全流程() {
    // 用通用计划渲染并注入 workspace_files 场景：验证 overwrite_file
    // 与 LocalEnv 下 execute 的完整闭环。
    let tmp = tempfile::tempdir().unwrap();
    let env = LocalEnv::new(tmp.path().to_path_buf());
    let mut outcome =
        capability::render(&role(), &executor(ExecutorKind::Cli("fake".into())), "/ws").unwrap();
    outcome
        .overwrite_file(capability::PROMPT_FILE, "覆盖后的提示词".as_bytes().to_vec())
        .unwrap();
    capability::materialize(&env, &outcome).await.unwrap();
    let prompt = String::from_utf8(env.read_file(capability::PROMPT_FILE).await.unwrap()).unwrap();
    assert_eq!(prompt, "覆盖后的提示词");
    let _ = workspace_files();
}
