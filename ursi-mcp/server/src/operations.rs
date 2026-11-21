//! 平台 MCP 交互操作。目录发现不会赋予工具调用权限。
use super::*;
use reqwest::{
    Url,
    header::{HeaderMap, HeaderValue},
};
use serde_json::Map;

#[derive(Default, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub allowed_tools: Vec<String>,
    pub github_toolsets: Vec<String>,
    pub github_read_only: bool,
}
impl Settings {
    pub fn empty(&self) -> bool {
        self == &Self::default()
    }
    pub fn validate(&self, url: &Url) -> Result<(), Error> {
        let unique = |names: &[String]| names.iter().collect::<HashSet<_>>().len() == names.len();
        if self.allowed_tools.len() > 1024
            || !unique(&self.allowed_tools)
            || self.allowed_tools.iter().any(|v| !label(v, 128))
        {
            return Err(invalid("允许调用的工具名无效或重复"));
        }
        if self.github_toolsets.len() > 64
            || !unique(&self.github_toolsets)
            || self.github_toolsets.iter().any(|v| {
                v.is_empty()
                    || v.len() > 64
                    || !v
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
            })
        {
            return Err(invalid("GitHub 工具集标识无效或重复"));
        }
        if (self.github_read_only || !self.github_toolsets.is_empty())
            && url.as_str() != "https://api.githubcopilot.com/mcp/"
        {
            return Err(invalid("GitHub 工具集设置仅适用于官方默认端点"));
        }
        Ok(())
    }
    pub fn headers(&self, url: &Url) -> Result<HeaderMap, Error> {
        self.validate(url)?;
        let mut h = HeaderMap::new();
        if self.github_read_only {
            h.insert("x-mcp-readonly", HeaderValue::from_static("true"));
        }
        if !self.github_toolsets.is_empty() {
            h.insert(
                "x-mcp-toolsets",
                HeaderValue::from_str(&self.github_toolsets.join(","))
                    .map_err(|_| invalid("GitHub 工具集无效"))?,
            );
        }
        Ok(h)
    }
}
#[derive(Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Catalog {
    Tools,
    Prompts,
    Templates,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Input {
    pub name: String,
    #[serde(default)]
    pub arguments: Map<String, Value>,
}

enum Action {
    List(Catalog),
    Tool(Input),
    Prompt(Input),
}
impl McpPlatform {
    pub async fn catalog(&self, id: &str, kind: Catalog) -> Result<Value, Error> {
        self.run(id, Action::List(kind)).await
    }
    pub async fn call_tool(&self, id: &str, input: Input) -> Result<Value, Error> {
        self.run(id, Action::Tool(input)).await
    }
    pub async fn get_prompt(&self, id: &str, input: Input) -> Result<Value, Error> {
        self.run(id, Action::Prompt(input)).await
    }
    async fn run(&self, id: &str, action: Action) -> Result<Value, Error> {
        let cfg = self.lookup(id)?;
        let authorize_tool = |cfg: &Config, name: &str| -> Result<(), Error> {
            if !cfg
                .settings
                .as_ref()
                .is_some_and(|s| s.allowed_tools.iter().any(|s| s == name))
            {
                return Err(invalid("此工具尚未授权调用"));
            }
            policy::authorize_operation(self, cfg, Some(name))?;
            Ok(())
        };
        match &action {
            Action::Tool(v) | Action::Prompt(v) if !label(&v.name, 128) => {
                return Err(invalid("名称无效"));
            }
            Action::Tool(v) => authorize_tool(&cfg, &v.name)?,
            Action::Prompt(v) if !v.arguments.values().all(Value::is_string) => {
                return Err(invalid("提示词参数值须为字符串"));
            }
            _ => (),
        }
        let _permit = self.operation()?;
        timeout(Duration::from_secs(25), async {
            let session = client::Session::open(self, &cfg).await?;
            let result = async {
                match action {
                    Action::List(kind) => session.catalog(kind).await,
                    Action::Prompt(input) => session.prompt(input).await,
                    Action::Tool(input) => {
                        let latest = self.lookup(id)?;
                        authorize_tool(&latest, &input.name)?;
                        if latest.settings != cfg.settings {
                            return Err(invalid("服务设置已更改，请重新发现"));
                        }
                        session.call(input).await
                    }
                }
            }
            .await;
            session.close().await;
            result
        })
        .await
        .map_err(|_| unavailable("MCP 操作超时；如已提交工具调用，请先核实远端结果"))?
    }
}
