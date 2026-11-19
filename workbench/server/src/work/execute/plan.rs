use super::Error;
use serde::Deserialize;
use serde_json::Value;

// Catalog freezes a projected executor and the merged, expanded resources here.
// The only execution adapter currently exposed by this contract is Agent.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Binding {
    executor: Executor,
    resources: Vec<Resource>,
    #[serde(rename = "configPackage")]
    _config_package: Option<Value>,
    _config: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Executor {
    id: String,
    revision: u64,
    #[serde(rename = "configSchema")]
    _config_schema: Option<Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Resource {
    id: String,
    revision: u64,
    kind: String,
    content: Value,
}

pub(super) enum Plan {
    Agent(String),
}

impl Plan {
    /// 本次尝试冻结后传给执行器的工作指令正文。
    pub(super) fn instruction(&self) -> String {
        match self {
            Self::Agent(text) => text.clone(),
        }
    }
}

fn unsupported_legacy_executor(executor: &Value) -> bool {
    executor.as_object().is_some_and(|object| {
        ["kind", "environment", "flowId", "flowRevision"]
            .iter()
            .any(|field| object.contains_key(*field))
    })
}

pub(super) fn config_package(item: &Value, action: &str) -> Result<Option<String>, Error> {
    let binding = item["packageSnapshot"]["actions"]
        .get(action)
        .ok_or_else(|| Error::Invalid("工作包没有此动作".into()))?;
    let Some(reference) = binding.get("configPackage") else {
        return Ok(None);
    };
    reference
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .map(str::to_owned)
        .ok_or_else(|| Error::Invalid("configPackage.id 必须是非空字符串".into()))
        .map(Some)
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
    if unsupported_legacy_executor(&binding["executor"]) {
        return Err(Error::Unavailable(
            "该执行器使用尚未迁移的后端配置，当前不可用".into(),
        ));
    }
    let Binding {
        executor,
        resources,
        ..
    } = serde_json::from_value(binding.clone())
        .map_err(|e| Error::Invalid(format!("不支持的动作绑定: {e}")))?;
    if executor.id.trim().is_empty() || executor.revision == 0 || !item["input"].is_object() {
        return Err(Error::Invalid("需要固定执行器版本与对象类型的输入".into()));
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
    Ok((Plan::Agent(prompt), binding.clone()))
}
