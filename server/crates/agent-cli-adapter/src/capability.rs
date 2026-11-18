//! 能力渲染：把 Role 渲染为会话工作区配置文件集与 CLI 启动参数。
//!
//! 职责边界：
//! - 纯渲染逻辑（路径规范化、凭据占位提取、文件集与参数向量生成）可独立验证；
//! - 渲染产物 [`RenderOutcome`] 经 [`materialize`] 写入 [`ExecutionEnv`]，
//!   经 [`cleanup`] 幂等删除；
//! - 凭据只产出 `{{cred:...}}` 引用占位清单，真实凭据由执行环境装配方提供，
//!   本模块不接触、不落盘任何真实凭据；
//! - 具体 CLI 的参数特化通过 [`CliRenderPlan`] 扩展，默认 [`GenericCliPlan`]
//!   生成通用参数向量。
//!
//! 路径契约：所有文件路径为 workspace 内相对路径，经 [`normalize_rel`]
//! 拒绝绝对路径与 `..` 穿越后原样交给 ExecutionEnv；ExecutionEnv 的
//! 路径解析与 exec 的 cwd 均以 workspace_root 为根，由装配方保证。

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use serde_json::json;
use ursi_domain::{ExecutionEnv, Executor, ExecutorKind, Role};

/// 会话工作区配置根目录。
pub const URSI_DIR: &str = ".ursi";
/// 会话配置文件目录。
pub const SESSION_DIR: &str = ".ursi/session";
/// 技能文件根目录。
pub const SKILLS_DIR: &str = ".ursi/skills";
/// 角色能力配置文件（prompt/model/skills/mcp_servers 与约定路径）。
pub const CONFIG_FILE: &str = ".ursi/session/config.json";
/// 任务提示词文件（CLI 经 `--prompt-file` 读取）。
pub const PROMPT_FILE: &str = ".ursi/session/prompt.txt";
/// 凭据占位文件（shell source 兼容，仅含 `{{cred:...}}` 引用）。
pub const CREDENTIALS_FILE: &str = ".ursi/session/credentials.env";
/// 产物声明文件（CLI 写入 `[{name, path, mediaType?}]`）。
pub const ARTIFACTS_MANIFEST_FILE: &str = ".ursi/session/artifacts.json";
/// Skill 包入口文件约定（与 server roles 域的 `SKILL_ENTRY` 一致）。
pub const SKILL_ENTRY: &str = "SKILL.md";
/// 凭据占位环境变量前缀。
pub const CRED_ENV_PREFIX: &str = "URSI_CRED_";

const CRED_REF_OPEN: &str = "{{cred:";
const CRED_REF_CLOSE: &str = "}}";

/// 渲染与环境操作错误。
#[derive(Debug, thiserror::Error)]
pub enum RenderError {
    #[error("路径非法：{0}")]
    InvalidPath(String),
    #[error("技能名非法：{0}")]
    InvalidSkillName(String),
    #[error("CLI 名非法：{0}")]
    InvalidCliName(String),
    #[error("凭据引用非法：{{cred:{0}}}")]
    InvalidCredentialRef(String),
    #[error("凭据环境变量键冲突：{0}")]
    CredentialKeyConflict(String),
    #[error("配置序列化失败：{0}")]
    Encode(String),
    #[error("环境操作失败：{0}")]
    Env(String),
}

/// 渲染产物：工作区文件集、CLI 参数向量与凭据注入占位清单。
#[derive(Debug, Clone)]
pub struct RenderOutcome {
    files: Vec<(String, Vec<u8>)>,
    argv: Vec<String>,
    env: Vec<(String, String)>,
}

impl RenderOutcome {
    /// 渲染出的全部文件（workspace 相对路径 + 字节）。
    pub fn files(&self) -> &[(String, Vec<u8>)] {
        &self.files
    }

    /// CLI 启动参数向量（argv[0] 为 CLI 名；Mock 类型为空）。
    pub fn argv(&self) -> &[String] {
        &self.argv
    }

    /// 凭据注入清单（环境变量键 + `{{cred:...}}` 引用占位）。
    pub fn env(&self) -> &[(String, String)] {
        &self.env
    }

    /// 覆盖已渲染文件内容（如 CliAdapter 写入任务提示词）。
    pub fn overwrite_file(&mut self, rel: &str, bytes: Vec<u8>) -> Result<(), RenderError> {
        let entry = self
            .files
            .iter_mut()
            .find(|(r, _)| r == rel)
            .ok_or_else(|| RenderError::InvalidPath(format!("渲染结果中不存在文件：{rel}")))?;
        entry.1 = bytes;
        Ok(())
    }
}

/// 渲染上下文：渲染计划可见的输入。
#[derive(Debug, Clone, Copy)]
pub struct RenderContext<'a> {
    pub role: &'a Role,
    pub executor: &'a Executor,
    pub workspace_root: &'a str,
}

/// CLI 专属渲染片段：参数向量与额外配置文件。
#[derive(Debug, Clone)]
pub struct PlannedCli {
    /// CLI 启动参数向量（argv[0] 为 CLI 名）。
    pub argv: Vec<String>,
    /// 计划追加的额外配置文件（相对路径 + 字节），与基础文件集合并。
    pub extra_files: Vec<(String, Vec<u8>)>,
}

/// 具体 CLI 的特化渲染计划：决定参数向量与额外配置文件。
///
/// 默认 [`GenericCliPlan`] 生成通用参数；接入具体 CLI 时实现本 trait
/// 提供特化参数与文件，不需要改动渲染主流程。
pub trait CliRenderPlan: Send + Sync {
    fn plan(&self, ctx: &RenderContext<'_>) -> Result<PlannedCli, RenderError>;
}

/// 通用渲染计划：对 CLI 类型生成通用参数向量，对 Mock 类型产出空向量。
pub struct GenericCliPlan;

impl CliRenderPlan for GenericCliPlan {
    fn plan(&self, ctx: &RenderContext<'_>) -> Result<PlannedCli, RenderError> {
        match &ctx.executor.kind {
            // mock 不经 CLI 启动，参数向量为空。
            ExecutorKind::Mock => Ok(PlannedCli {
                argv: Vec::new(),
                extra_files: Vec::new(),
            }),
            ExecutorKind::Cli(name) => {
                let trimmed = name.trim();
                if trimmed.is_empty() {
                    return Err(RenderError::InvalidCliName(name.clone()));
                }
                let mut argv = vec![
                    trimmed.to_string(),
                    "--config".to_string(),
                    CONFIG_FILE.to_string(),
                    "--prompt-file".to_string(),
                    PROMPT_FILE.to_string(),
                ];
                if let Some(model) = &ctx.role.model {
                    if !model.trim().is_empty() {
                        argv.push("--model".to_string());
                        argv.push(model.clone());
                    }
                }
                Ok(PlannedCli {
                    argv,
                    extra_files: Vec::new(),
                })
            }
        }
    }
}

/// 能力清单渲染器：持有 CLI 渲染计划，把 Role 渲染为工作区文件集、
/// 参数向量与凭据占位清单。
#[derive(Clone)]
pub struct CapabilityManifest {
    plan: Arc<dyn CliRenderPlan>,
}

impl CapabilityManifest {
    pub fn new(plan: Arc<dyn CliRenderPlan>) -> Self {
        Self { plan }
    }

    /// 使用通用渲染计划构造。
    pub fn generic() -> Self {
        Self::new(Arc::new(GenericCliPlan))
    }

    /// 渲染 Role 为会话工作区配置。
    ///
    /// 基础文件集：
    /// - [`CONFIG_FILE`]：角色 prompt/model/skills/mcp_servers 与约定路径；
    /// - [`PROMPT_FILE`]：角色提示词（CliAdapter 运行时用任务提示词覆盖）；
    /// - `.ursi/skills/<skill>/SKILL.md`：技能占位文件（domain Role 只携带
    ///   技能名，完整文件包由装配方经自定义 CliRenderPlan 注入）；
    /// - [`CREDENTIALS_FILE`]：存在凭据引用时的占位注入文件。
    pub fn render(
        &self,
        role: &Role,
        executor: &Executor,
        workspace_root: &str,
    ) -> Result<RenderOutcome, RenderError> {
        if workspace_root.trim().is_empty() {
            return Err(RenderError::InvalidPath("workspace_root 为空".to_string()));
        }
        let env_manifest = credential_env(role)?;
        let mut files = vec![
            (
                CONFIG_FILE.to_string(),
                config_bytes(role, workspace_root)?,
            ),
            (PROMPT_FILE.to_string(), role.prompt.as_bytes().to_vec()),
        ];
        for skill in &role.skills {
            files.push((skill_file(skill)?, skill_stub_bytes(skill)));
        }
        if !env_manifest.is_empty() {
            files.push((
                CREDENTIALS_FILE.to_string(),
                credentials_env_bytes(&env_manifest),
            ));
        }

        let ctx = RenderContext {
            role,
            executor,
            workspace_root,
        };
        let planned = self.plan.plan(&ctx)?;

        let mut seen: HashSet<String> = files.iter().map(|(r, _)| r.clone()).collect();
        for (rel, bytes) in planned.extra_files {
            let rel = normalize_rel(&rel)?;
            if !seen.insert(rel.clone()) {
                return Err(RenderError::InvalidPath(format!("重复路径：{rel}")));
            }
            files.push((rel, bytes));
        }

        Ok(RenderOutcome {
            files,
            argv: planned.argv,
            env: env_manifest,
        })
    }
}

/// 使用通用渲染计划渲染 Role（便捷入口）。
pub fn render(
    role: &Role,
    executor: &Executor,
    workspace_root: &str,
) -> Result<RenderOutcome, RenderError> {
    CapabilityManifest::generic().render(role, executor, workspace_root)
}

/// 把渲染产物写入执行环境。依赖 env.write_file 创建父目录
/// （ExecutionEnv 实现方职责）。部分写入失败时调用方应继续执行 [`cleanup`]。
pub async fn materialize(env: &dyn ExecutionEnv, outcome: &RenderOutcome) -> Result<(), RenderError> {
    for (rel, bytes) in outcome.files() {
        env.write_file(rel, bytes)
            .await
            .map_err(|e| RenderError::Env(format!("写入 {rel} 失败：{e}")))?;
    }
    Ok(())
}

/// 删除渲染文件与临时凭据占位文件。
///
/// ExecutionEnv 无删除接口，清理经 `rm -f` 执行；路径均为已规范化相对
/// 路径且经单引号转义。`rm -f` 对缺失文件不报错，因此清理幂等。
pub async fn cleanup(env: &dyn ExecutionEnv, outcome: &RenderOutcome) -> Result<(), RenderError> {
    if outcome.files().is_empty() {
        return Ok(());
    }
    let mut cmd = String::from("rm -f --");
    // 逆序删除：凭据占位文件在文件集末位，最先清理。
    for (rel, _) in outcome.files().iter().rev() {
        cmd.push(' ');
        cmd.push_str(&shell_quote(rel));
    }
    let (code, _) = env
        .exec(&cmd)
        .await
        .map_err(|e| RenderError::Env(format!("清理命令执行失败：{e}")))?;
    if code != 0 {
        return Err(RenderError::Env(format!("清理命令退出码 {code}")));
    }
    Ok(())
}

/// 技能包入口文件的 workspace 相对路径。
pub fn skill_file(skill: &str) -> Result<String, RenderError> {
    validate_skill_name(skill)?;
    Ok(format!("{SKILLS_DIR}/{skill}/{SKILL_ENTRY}"))
}

/// 规范化 workspace 相对路径：拒绝绝对路径、反斜杠、NUL、空段、`.` 与 `..`。
pub fn normalize_rel(rel: &str) -> Result<String, RenderError> {
    let bad = || RenderError::InvalidPath(rel.to_string());
    if rel.starts_with('/') || rel.contains('\\') || rel.contains('\0') {
        return Err(bad());
    }
    let comps: Vec<&str> = rel.split('/').collect();
    if comps.iter().any(|s| *s == "" || *s == "." || *s == "..") {
        return Err(bad());
    }
    Ok(comps.join("/"))
}

fn validate_skill_name(skill: &str) -> Result<(), RenderError> {
    // 技能名必须是单一普通路径组件；前导 '.' 一并拒绝，避免命中 .ursi 等配置目录。
    if skill.is_empty() || skill.starts_with('.') || component_invalid(skill) {
        return Err(RenderError::InvalidSkillName(skill.to_string()));
    }
    Ok(())
}

fn component_invalid(seg: &str) -> bool {
    seg.is_empty() || seg == "." || seg == ".." || seg.contains('/') || seg.contains('\0')
}

/// 从 Role 全部字符串字段提取 `{{cred:...}}` 引用并派生注入清单。
///
/// 只扫描 `{{cred:name}}` 模板形态（与 server roles 域的凭据引用约定对齐）；
/// 清单值仅为引用占位本身，不含任何真实凭据。
fn credential_env(role: &Role) -> Result<Vec<(String, String)>, RenderError> {
    let mut names = extract_credential_refs(&role.prompt)?;
    for s in role.skills.iter() {
        names.extend(extract_credential_refs(s)?);
    }
    for s in role.mcp_servers.iter() {
        names.extend(extract_credential_refs(s)?);
    }
    if let Some(m) = &role.model {
        names.extend(extract_credential_refs(m)?);
    }

    // 已去重的引用名派生同名键必是两个不同引用（如 a-b 与 a_b），显式冲突报错。
    let mut env = Vec::new();
    let mut seen: HashMap<String, String> = HashMap::new();
    for name in names {
        let key = cred_env_key(&name)?;
        if let Some(prev) = seen.get(&key) {
            if prev != &name {
                return Err(RenderError::CredentialKeyConflict(key));
            }
            continue;
        }
        seen.insert(key.clone(), name.clone());
        env.push((key, format!("{CRED_REF_OPEN}{name}{CRED_REF_CLOSE}")));
    }
    Ok(env)
}

/// 按出现顺序提取去重后的引用名；未闭合的 `{{cred:` 前缀不是合法引用，忽略。
fn extract_credential_refs(s: &str) -> Result<Vec<String>, RenderError> {
    let mut names: Vec<String> = Vec::new();
    let mut rest = s;
    while let Some(pos) = rest.find(CRED_REF_OPEN) {
        let after = &rest[pos + CRED_REF_OPEN.len()..];
        let Some(end) = after.find(CRED_REF_CLOSE) else {
            break;
        };
        let name = &after[..end];
        if !valid_cred_name(name) {
            return Err(RenderError::InvalidCredentialRef(name.to_string()));
        }
        if !names.iter().any(|n| n == name) {
            names.push(name.to_string());
        }
        rest = &after[end + CRED_REF_CLOSE.len()..];
    }
    Ok(names)
}

fn valid_cred_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
}

/// 引用名 → 环境变量键：非字母数字折叠为 `_` 并去重，统一大写。
fn cred_env_key(name: &str) -> Result<String, RenderError> {
    let mut key = String::from(CRED_ENV_PREFIX);
    let mut prev_underscore = false;
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            key.push(c.to_ascii_uppercase());
            prev_underscore = false;
        } else if !prev_underscore {
            key.push('_');
            prev_underscore = true;
        }
    }
    if key == CRED_ENV_PREFIX {
        return Err(RenderError::InvalidCredentialRef(name.to_string()));
    }
    Ok(key)
}

fn config_bytes(role: &Role, workspace_root: &str) -> Result<Vec<u8>, RenderError> {
    let config = json!({
        "workspaceRoot": workspace_root,
        "promptFile": PROMPT_FILE,
        "artifactsManifest": ARTIFACTS_MANIFEST_FILE,
        "credentialsFile": CREDENTIALS_FILE,
        "role": role,
    });
    serde_json::to_vec(&config).map_err(|e| RenderError::Encode(e.to_string()))
}

fn skill_stub_bytes(skill: &str) -> Vec<u8> {
    format!(
        "# {skill}\n\n由 ursi-agent-cli-adapter 渲染的技能占位文件。\
         domain Role 仅携带技能名，完整文件包由装配方经自定义 CliRenderPlan 注入。\n"
    )
    .into_bytes()
}

fn credentials_env_bytes(env: &[(String, String)]) -> Vec<u8> {
    let mut out =
        String::from("# 凭据占位清单：仅含 {{cred:...}} 引用，真实凭据由执行环境装配方提供。\n");
    for (key, placeholder) in env {
        out.push_str("export ");
        out.push_str(key);
        out.push('=');
        out.push_str(&shell_quote(placeholder));
        out.push('\n');
    }
    out.into_bytes()
}

/// POSIX sh 单引号转义：cleanup 的 rm、credentials.env 与 CliAdapter
/// 命令拼装共用同一规则，装配方自行拼命令时也可复用。
pub fn shell_quote(s: &str) -> String {
    if s.is_empty() {
        return "''".to_string();
    }
    let mut quoted = String::with_capacity(s.len() + 2);
    quoted.push('\'');
    for c in s.chars() {
        if c == '\'' {
            quoted.push_str("'\\''");
        } else {
            quoted.push(c);
        }
    }
    quoted.push('\'');
    quoted
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_env::LocalEnv;
    use ursi_domain::EnvError;

    fn role() -> Role {
        Role {
            id: "r1".to_string(),
            name: "评审员".to_string(),
            prompt: "严格评审 {{cred:api-key}}".to_string(),
            model: Some("claude-sonnet".to_string()),
            skills: vec!["code-review".to_string()],
            mcp_servers: vec!["github".to_string()],
            executor_id: None,
        }
    }

    fn cli_executor(name: &str) -> Executor {
        Executor {
            id: "e1".to_string(),
            name: "CLI".to_string(),
            kind: ExecutorKind::Cli(name.to_string()),
        }
    }

    fn mock_executor() -> Executor {
        Executor {
            id: "m1".to_string(),
            name: "Mock".to_string(),
            kind: ExecutorKind::Mock,
        }
    }

    fn find<'a>(files: &'a [(String, Vec<u8>)], rel: &str) -> &'a [u8] {
        files
            .iter()
            .find(|(r, _)| r == rel)
            .map(|(_, b)| b.as_slice())
            .unwrap_or_else(|| panic!("缺少文件 {rel}"))
    }

    #[test]
    fn render_contains_role_values() {
        let r = role();
        let outcome = render(&r, &cli_executor("pi"), "/ws").unwrap();

        let config = std::str::from_utf8(find(outcome.files(), CONFIG_FILE)).unwrap();
        assert!(config.contains("\"model\":\"claude-sonnet\""));
        assert!(config.contains("github"));
        assert!(config.contains("code-review"));
        assert!(config.contains("严格评审"));
        assert!(config.contains(PROMPT_FILE));

        assert_eq!(
            std::str::from_utf8(find(outcome.files(), PROMPT_FILE)).unwrap(),
            "严格评审 {{cred:api-key}}"
        );

        let skill =
            std::str::from_utf8(find(outcome.files(), ".ursi/skills/code-review/SKILL.md")).unwrap();
        assert!(skill.contains("code-review"));

        assert_eq!(
            outcome.argv(),
            [
                "pi",
                "--config",
                CONFIG_FILE,
                "--prompt-file",
                PROMPT_FILE,
                "--model",
                "claude-sonnet"
            ]
        );
        assert_eq!(
            outcome.env(),
            [(
                "URSI_CRED_API_KEY".to_string(),
                "{{cred:api-key}}".to_string()
            )]
        );
    }

    #[test]
    fn mock_kind_renders_empty_argv() {
        let r = role();
        let outcome = render(&r, &mock_executor(), "/ws").unwrap();
        assert!(outcome.argv().is_empty());
        // 凭据占位清单与配置文件仍照常渲染。
        assert_eq!(
            outcome.env(),
            [(
                "URSI_CRED_API_KEY".to_string(),
                "{{cred:api-key}}".to_string()
            )]
        );
    }

    #[test]
    fn rejects_traversal_skill_names() {
        let mut r = role();
        for bad in ["../escape", "a/b", ".hidden", "..", "."] {
            r.skills = vec![bad.to_string()];
            assert!(
                matches!(
                    render(&r, &cli_executor("pi"), "/ws"),
                    Err(RenderError::InvalidSkillName(_))
                ),
                "技能名 {bad} 应被拒绝"
            );
        }
    }

    #[test]
    fn normalize_rel_rejects_unsafe_paths() {
        for bad in [
            "/abs", "a/../b", "..", ".", "a//b", "", "a\\b", "./a", "a/", "\0",
        ] {
            assert!(
                normalize_rel(bad).is_err(),
                "路径 {bad:?} 应被拒绝"
            );
        }
        assert_eq!(normalize_rel("a/b/c").unwrap(), "a/b/c");
    }

    #[test]
    fn rejects_empty_workspace_root() {
        let r = role();
        assert!(matches!(
            render(&r, &cli_executor("pi"), "  "),
            Err(RenderError::InvalidPath(_))
        ));
    }

    #[test]
    fn env_manifest_contains_only_placeholders() {
        let mut r = role();
        r.prompt = "调用 sk-SECRET-MARKER，引用 {{cred:api-key}} 与 {{cred:mcp-token}}，重复 {{cred:api-key}}"
            .to_string();
        let outcome = render(&r, &cli_executor("pi"), "/ws").unwrap();

        assert_eq!(
            outcome.env(),
            [
                (
                    "URSI_CRED_API_KEY".to_string(),
                    "{{cred:api-key}}".to_string()
                ),
                (
                    "URSI_CRED_MCP_TOKEN".to_string(),
                    "{{cred:mcp-token}}".to_string()
                ),
            ]
        );
        for (_, value) in outcome.env() {
            assert!(value.starts_with("{{cred:") && value.ends_with("}}"));
            assert!(!value.contains("sk-SECRET-MARKER"));
        }
        // 凭据占位文件同样不含明文。
        let cred = std::str::from_utf8(find(outcome.files(), CREDENTIALS_FILE)).unwrap();
        assert!(cred.contains("export URSI_CRED_API_KEY='{{cred:api-key}}'"));
        assert!(!cred.contains("sk-SECRET-MARKER"));
    }

    #[test]
    fn conflicting_cred_names_are_rejected() {
        let mut r = role();
        r.prompt = "{{cred:a-b}} {{cred:a_b}}".to_string();
        match render(&r, &cli_executor("pi"), "/ws") {
            Err(RenderError::CredentialKeyConflict(key)) => assert_eq!(key, "URSI_CRED_A_B"),
            other => panic!("应返回键冲突错误，实际 {other:?}"),
        }
    }

    #[test]
    fn invalid_and_unclosed_cred_refs() {
        let mut r = role();
        r.prompt = "{{cred:bad name!}}".to_string();
        assert!(matches!(
            render(&r, &cli_executor("pi"), "/ws"),
            Err(RenderError::InvalidCredentialRef(_))
        ));
        // 未闭合前缀不是合法引用，忽略且不产生注入项。
        r.prompt = "前缀 {{cred:x 未闭合".to_string();
        let outcome = render(&r, &cli_executor("pi"), "/ws").unwrap();
        assert!(outcome.env().is_empty());
        assert!(outcome.files().iter().all(|(rel, _)| rel != CREDENTIALS_FILE));
    }

    struct ExtraPlan {
        files: Vec<(String, Vec<u8>)>,
    }

    impl CliRenderPlan for ExtraPlan {
        fn plan(&self, _ctx: &RenderContext<'_>) -> Result<PlannedCli, RenderError> {
            Ok(PlannedCli {
                argv: vec!["custom-cli".to_string()],
                extra_files: self.files.clone(),
            })
        }
    }

    #[test]
    fn custom_plan_merges_extra_files() {
        let manifest = CapabilityManifest::new(Arc::new(ExtraPlan {
            files: vec![("plan/extra.txt".to_string(), b"hi".to_vec())],
        }));
        let r = role();
        let outcome = manifest.render(&r, &cli_executor("pi"), "/ws").unwrap();
        assert_eq!(find(outcome.files(), "plan/extra.txt"), b"hi");
        assert_eq!(outcome.argv(), ["custom-cli"]);
    }

    #[test]
    fn custom_plan_extra_files_are_validated() {
        let r = role();
        for bad in [
            "../evil".to_string(),
            CONFIG_FILE.to_string(), // 重复路径
        ] {
            let manifest = CapabilityManifest::new(Arc::new(ExtraPlan {
                files: vec![(bad.clone(), Vec::new())],
            }));
            assert!(
                manifest.render(&r, &cli_executor("pi"), "/ws").is_err(),
                "计划文件 {bad} 应被拒绝"
            );
        }
    }

    #[tokio::test]
    async fn materialize_and_cleanup_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let env = LocalEnv::new(tmp.path().to_path_buf());
        let r = role();
        let outcome = render(&r, &cli_executor("pi"), "/ws").unwrap();

        materialize(&env, &outcome).await.unwrap();
        assert_eq!(
            env.read_file(PROMPT_FILE).await.unwrap(),
            r.prompt.as_bytes()
        );
        env.read_file(CONFIG_FILE).await.unwrap();
        env.read_file(CREDENTIALS_FILE).await.unwrap();
        env.read_file(".ursi/skills/code-review/SKILL.md")
            .await
            .unwrap();

        cleanup(&env, &outcome).await.unwrap();
        for rel in [PROMPT_FILE, CONFIG_FILE, CREDENTIALS_FILE] {
            assert!(
                matches!(env.read_file(rel).await, Err(EnvError::FileNotFound(_))),
                "{rel} 应已删除"
            );
        }
        // 幂等：重复清理不报错。
        cleanup(&env, &outcome).await.unwrap();
    }
}
