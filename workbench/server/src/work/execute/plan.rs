use super::Error;
use serde::Deserialize;
use serde_json::Value;

// catalog freezes a projected executor and the merged, expanded resources here.
// Port declarations are publication checks, not fields of the frozen action.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Binding {
    executor: Executor,
    resources: Vec<Resource>,
    // Configuration is consumed by execute when an attempt is reserved. Keep
    // it optional so catalog's older projection remains valid.
    #[serde(rename = "configPackage")]
    _config_package: Option<Value>,
    _config: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Executor {
    id: String,
    revision: u64,
    kind: String,
    #[serde(default)]
    environment: Environment,
    flow_id: Option<String>,
    flow_revision: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Resource {
    id: String,
    revision: u64,
    kind: String,
    content: Value,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Environment {
    #[default]
    Local,
    Sandbox,
}

pub(super) enum Plan {
    Agent(String),
    Sandbox(String),
    Flow {
        id: String,
        revision: String,
        variables: Value,
    },
}

impl Plan {
    /// 本次尝试冻结后传给执行器的工作指令正文。
    pub(super) fn instruction(&self) -> String {
        match self {
            Self::Agent(text) | Self::Sandbox(text) => text.clone(),
            Self::Flow { variables, .. } => variables.to_string(),
        }
    }
}

pub(super) fn resolve(item: &Value, action: &str) -> Result<(Plan, Value), Error> {
    if item["status"] != "working" {
        return Err(Error::Conflict("工作项必须处于 working 状态".into()));
    }
    if item["source"]["type"] == "connector" && item["source"]["action"] != action {
        return Err(Error::Invalid("动作不在此来源的派工授权内".into()));
    }
    let snapshot = &item["packageSnapshot"];
    let binding = snapshot["actions"]
        .get(action)
        .ok_or_else(|| Error::Invalid("工作包没有此动作".into()))?;
    let Binding {
        executor,
        resources,
        ..
    } = serde_json::from_value(binding.clone())
        .map_err(|e| Error::Invalid(format!("不支持的动作绑定: {e}")))?;
    if executor.id.trim().is_empty() || executor.revision == 0 || !item["input"].is_object() {
        return Err(Error::Invalid("需要固定执行器版本与对象类型的输入".into()));
    }
    let plan = match executor.kind.as_str() {
        "agent" => {
            if executor.flow_id.is_some() || executor.flow_revision.is_some() {
                return Err(Error::Invalid("Agent 不能绑定 Flow".into()));
            }
            let sop = snapshot["sop"]
                .as_str()
                .ok_or_else(|| Error::Invalid("Agent 需要文本 SOP".into()))?;
            let mut prompt = format!("执行动作：{action}\n\nSOP：\n{sop}\n");
            for r in resources {
                if !matches!(r.kind.as_str(), "skill" | "prompt") {
                    return Err(Error::Invalid(format!(
                        "Agent 不支持 {} 资源 {}",
                        r.kind, r.id
                    )));
                }
                let content = r
                    .content
                    .as_str()
                    .filter(|s| !s.trim().is_empty())
                    .ok_or_else(|| Error::Invalid("skill/prompt 需要文本内容".into()))?;
                if r.id.trim().is_empty() || r.revision == 0 {
                    return Err(Error::Invalid("资源缺少固定版本".into()));
                }
                prompt.push_str(&format!(
                    "\n{} {}@{}：\n{content}\n",
                    r.kind, r.id, r.revision
                ));
            }
            prompt.push_str(&format!("\n工作项输入（JSON）：\n{}\n", item["input"]));
            if prompt.len() > 256 * 1024 {
                return Err(Error::Invalid("Agent 输入超过 256 KiB".into()));
            }
            match executor.environment {
                Environment::Local => Plan::Agent(prompt),
                Environment::Sandbox => Plan::Sandbox(prompt),
            }
        }
        "flow" => {
            if binding["executor"].get("environment").is_some() {
                return Err(Error::Invalid("Flow 不接受 environment".into()));
            }
            if !resources.is_empty() {
                return Err(Error::Invalid(
                    "Flow 不支持注入资源，请使用固定修订的 Flow 包".into(),
                ));
            }
            let id = executor
                .flow_id
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| Error::Invalid("Flow 缺少 flowId".into()))?;
            let revision = executor
                .flow_revision
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| Error::Invalid("Flow 缺少 flowRevision".into()))?;
            Plan::Flow {
                id,
                revision,
                variables: item["input"].clone(),
            }
        }
        _ => return Err(Error::Invalid("不支持的执行器类型".into())),
    };
    Ok((plan, binding.clone()))
}
