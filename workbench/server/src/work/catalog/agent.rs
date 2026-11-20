//! Agent 草稿与发布共用只读解析，快照只含运行所需的固定正文和命名引用。
use super::{
    Error, Reply,
    definitions::{fields, id, name, resolve_resources, text},
    policy,
};
use axum::Json;
use serde_json::{Value, json};
use std::collections::BTreeSet;

pub(super) async fn options() -> Reply {
    let policy = policy::load()?;
    Ok(Json(json!({
        "models": policy.models.iter().map(|id| json!({"id":id})).collect::<Vec<_>>(),
        "tools": policy.tools.keys().map(|id| json!({"id":id})).collect::<Vec<_>>(),
    })))
}

pub(super) fn preview(db: &Value, definition: &Value) -> Result<Value, Error> {
    fields(definition, &["id", "agent", "resources"])?;
    id(definition)?;
    let agent = &definition["agent"];
    fields(agent, &["systemPrompt", "modelProfile", "tools"])?;
    let prompt = text(agent, "systemPrompt")?;
    let model = name(text(agent, "modelProfile")?)?;
    let tool_ids = agent["tools"]
        .as_array()
        .ok_or_else(|| Error::Invalid("tools 必须是工具标识数组".into()))?;
    let mut skills = Vec::new();
    for resource in resolve_resources(db, definition)? {
        if resource["kind"] != "skill" {
            return Err(Error::Invalid(
                "Agent 只接受 skill 资源；固定提示词请填写 systemPrompt".into(),
            ));
        }
        skills.push(json!({"id":resource["id"], "revision":resource["revision"], "content":resource["content"]}));
    }
    let policy = policy::load()?;
    if !policy.models.contains(model) {
        return Err(Error::Invalid("模型未获管理员授权".into()));
    }
    let mut seen = BTreeSet::new();
    let mut tools = Vec::new();
    for tool in tool_ids {
        let id = name(
            tool.as_str()
                .ok_or_else(|| Error::Invalid("需要工具标识".into()))?,
        )?;
        let digest = policy
            .tools
            .get(id)
            .ok_or_else(|| Error::Invalid("工具未获管理员授权".into()))?;
        if !seen.insert(id) {
            return Err(Error::Invalid("工具标识不能重复".into()));
        }
        tools.push(json!({"id":id,"schemaDigest":digest}));
    }
    Ok(json!({"systemPrompt":prompt,"modelProfile":model,"skills":skills,"tools":tools}))
}
