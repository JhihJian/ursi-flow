//! 平台 MCP 交互操作。目录发现不会赋予工具调用权限。
use super::*;
use axum::routing::put;
use reqwest::{
    Url,
    header::{HeaderMap, HeaderValue},
};
use serde_json::Map;

#[derive(Default, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Settings {
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
pub(super) enum Catalog {
    Tools,
    Prompts,
    Templates,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Input {
    pub name: String,
    #[serde(default)]
    pub arguments: Map<String, Value>,
}

pub(super) fn routes() -> Router<Store> {
    Router::new()
        .route("/v2/mcp-servers/{id}/settings", put(settings))
        .route("/v2/mcp-servers/{id}/catalog/{kind}", get(catalog))
        .route("/v2/mcp-servers/{id}/tools/call", post(call))
        .route("/v2/mcp-servers/{id}/prompts/get", post(prompt))
}
async fn settings(
    State(store): State<Store>,
    Path(id): Path<String>,
    Json(s): Json<Settings>,
) -> Result<Json<Value>, Error> {
    let cfg = lookup(&store, &id)?;
    s.validate(&policy::authorize(&store, &cfg)?)?;
    store.update(|db| {
        let row = db[TABLE].get_mut(&id).ok_or_else(missing)?;
        row["settings"] = json!(s);
        Ok(Json(json!(s)))
    })
}
async fn catalog(
    State(store): State<Store>,
    Path((id, kind)): Path<(String, Catalog)>,
) -> Result<Json<Value>, Error> {
    run(store, id, Action::List(kind)).await
}
async fn call(
    State(store): State<Store>,
    Path(id): Path<String>,
    Json(input): Json<Input>,
) -> Result<Json<Value>, Error> {
    run(store, id, Action::Tool(input)).await
}
async fn prompt(
    State(store): State<Store>,
    Path(id): Path<String>,
    Json(input): Json<Input>,
) -> Result<Json<Value>, Error> {
    run(store, id, Action::Prompt(input)).await
}
enum Action {
    List(Catalog),
    Tool(Input),
    Prompt(Input),
}
async fn run(store: Store, id: String, action: Action) -> Result<Json<Value>, Error> {
    let cfg = lookup(&store, &id)?;
    let authorize_tool = |cfg: &Config, name: &str| -> Result<(), Error> {
        if !cfg.settings.allowed_tools.iter().any(|s| s == name) {
            return Err(invalid("此工具尚未授权调用"));
        }
        policy::authorize_operation(&store, cfg, Some(name))?;
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
    let _permit = slot()?;
    timeout(Duration::from_secs(25), async {
        let session = client::Session::open(&store, &cfg).await?;
        let result = async {
            match action {
                Action::List(kind) => session.catalog(kind).await,
                Action::Prompt(input) => session.prompt(input).await,
                Action::Tool(input) => {
                    let latest = lookup(&store, &id)?;
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
        result.map(Json)
    })
    .await
    .map_err(|_| unavailable("MCP 操作超时；如已提交工具调用，请先核实远端结果"))?
}
