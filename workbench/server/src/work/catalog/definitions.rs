//! 发布请求的允许字段、版本引用与冻结快照投影。
use super::{Error, require_active, version};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

fn fields(v: &Value, allowed: &[&str]) -> Result<(), Error> {
    let obj = v
        .as_object()
        .ok_or_else(|| Error::Invalid("需要 JSON 对象".into()))?;
    if obj.keys().any(|k| !allowed.contains(&k.as_str())) {
        return Err(Error::Invalid("定义含有不支持的字段".into()));
    }
    Ok(())
}
fn text<'a>(v: &'a Value, k: &str) -> Result<&'a str, Error> {
    v[k].as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| Error::Invalid(format!("{k} 必须是非空字符串")))
}
fn name(s: &str) -> Result<&str, Error> {
    if s.len() > 128
        || s.is_empty()
        || s.trim() != s
        || s == "."
        || s == ".."
        || !s
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Err(Error::Invalid("需要不含路径的名称".into()));
    }
    Ok(s)
}
pub(super) fn id(v: &Value) -> Result<&str, Error> {
    name(text(v, "id")?)
}
fn reference(v: &Value) -> Result<(&str, u64), Error> {
    fields(v, &["id", "revision"])?;
    Ok((
        id(v)?,
        v["revision"]
            .as_u64()
            .filter(|n| *n > 0)
            .ok_or_else(|| Error::Invalid("引用需要固定的正整数 revision".into()))?,
    ))
}
fn array<'a>(obj: &'a Value, k: &str) -> Result<&'a [Value], Error> {
    match obj.get(k) {
        None => Ok(&[]),
        Some(v) => v
            .as_array()
            .map(Vec::as_slice)
            .ok_or_else(|| Error::Invalid(format!("{k} 必须是数组"))),
    }
}
pub(super) fn build(db: &Value, k: &str, b: &Value) -> Result<Value, Error> {
    match k {
        "resources" => resource(b),
        "executors" => executor(db, b),
        "packages" => package(db, b),
        _ => Err(Error::Internal("未知目录类型".into())),
    }
}
fn resource(b: &Value) -> Result<Value, Error> {
    fields(b, &["id", "kind", "content"])?;
    match text(b, "kind")? {
        "prompt" | "skill" => {
            text(b, "content")?;
        }
        "mcp" => {
            // Only registered connection/credential names. No URLs, headers, commands or free-form configs.
            let c = &b["content"];
            fields(c, &["serverRef", "credentialRef"])?;
            name(text(c, "serverRef")?)?;
            if c.get("credentialRef").is_some() {
                name(text(c, "credentialRef")?)?;
            }
        }
        _ => return Err(Error::Invalid("未知资源 kind".into())),
    }
    Ok(b.clone())
}
fn ports<'a>(b: &'a Value, k: &str) -> Result<Option<&'a Map<String, Value>>, Error> {
    let Some(v) = b.get(k) else { return Ok(None) };
    let map = v
        .as_object()
        .ok_or_else(|| Error::Invalid(format!("{k} 必须是字段名到类型的对象")))?;
    for (key, ty) in map {
        name(key)?;
        if !matches!(
            ty.as_str(),
            Some("string" | "number" | "integer" | "boolean" | "object" | "array")
        ) {
            return Err(Error::Invalid(format!("{k} 类型无效")));
        }
    }
    Ok(Some(map))
}
fn compatible(
    required: Option<&Map<String, Value>>,
    provided: Option<&Map<String, Value>>,
    k: &str,
) -> Result<(), Error> {
    for (key, ty) in required.into_iter().flatten() {
        if provided.and_then(|p| p.get(key)) != Some(ty) {
            return Err(Error::Invalid(format!("{k} 声明不匹配: {key}")));
        }
    }
    Ok(())
}
fn executor(db: &Value, b: &Value) -> Result<Value, Error> {
    fields(
        b,
        &[
            "id",
            "kind",
            "resources",
            "environment",
            "flowId",
            "flowRevision",
            "inputs",
            "outputs",
        ],
    )?;
    ports(b, "inputs")?;
    ports(b, "outputs")?;
    let deps = array(b, "resources")?;
    match text(b, "kind")? {
        "agent" => {
            if let Some(env) = b.get("environment") {
                if !matches!(env.as_str(), Some("local" | "sandbox")) {
                    return Err(Error::Invalid(
                        "Agent environment 必须为 local 或 sandbox".into(),
                    ));
                }
            }
            if b.get("flowId").is_some() || b.get("flowRevision").is_some() {
                return Err(Error::Invalid("Agent 不能绑定 Flow".into()));
            }
        }
        "flow" => {
            if b.get("environment").is_some() {
                return Err(Error::Invalid("Flow 不接受 environment".into()));
            }
            name(text(b, "flowId")?)?;
            text(b, "flowRevision")?;
        }
        _ => return Err(Error::Invalid("未知执行器 kind".into())),
    }
    let mut budget = MAX_SNAPSHOT_BYTES;
    resources(db, b["kind"].as_str().unwrap(), deps.iter(), &mut budget)?;
    Ok(b.clone())
}
// Expanded references must not turn a tiny publish request into an unbounded snapshot.
const MAX_SNAPSHOT_BYTES: usize = 2 * 1024 * 1024;
fn resources<'a>(
    db: &Value,
    backend: &str,
    refs: impl Iterator<Item = &'a Value>,
    budget: &mut usize,
) -> Result<Vec<Value>, Error> {
    let mut seen = BTreeMap::new();
    let mut resolved = Vec::new();
    for r in refs {
        let (id, rev) = reference(r)?;
        if let Some(prior) = seen.insert(id, rev) {
            if prior != rev {
                return Err(Error::Conflict(format!("资源 {id} 绑定了两个版本")));
            }
            continue;
        }
        require_active(db, "resources", id)?;
        let v = version(db, "resources", id, rev)?;
        if backend == "flow" || v["kind"] == "mcp" {
            return Err(Error::Invalid(format!("{backend} 暂不支持注入资源 {id}")));
        }
        let size = v["content"].as_str().ok_or_else(super::corrupt)?.len() + id.len() + 64;
        *budget = budget
            .checked_sub(size)
            .ok_or_else(|| Error::Invalid("展开的资源超过 2 MiB".into()))?;
        resolved.push(v.clone());
    }
    Ok(resolved)
}
fn package(db: &Value, b: &Value) -> Result<Value, Error> {
    fields(
        b,
        &[
            "id",
            "sop",
            "acceptance",
            "actions",
            "resources",
            "goal",
            "inputs",
            "outputs",
            "deliverables",
        ],
    )?;
    text(b, "sop")?;
    text(b, "acceptance")?;
    let common = array(b, "resources")?;
    let ins = ports(b, "inputs")?;
    let outs = ports(b, "outputs")?;
    let actions = b["actions"]
        .as_object()
        .filter(|m| !m.is_empty())
        .ok_or_else(|| Error::Invalid("工作包需要至少一个 action".into()))?;
    let mut frozen = Map::new();
    let mut budget = MAX_SNAPSHOT_BYTES;
    for (action, binding) in actions {
        name(action)?;
        fields(binding, &["executor", "resources", "inputs", "outputs"])?;
        let (id, rev) = reference(&binding["executor"])?;
        require_active(db, "executors", id)?;
        let exec = version(db, "executors", id, rev)?;
        compatible(
            ports(exec, "inputs")?,
            ports(binding, "inputs")?.or(ins),
            "inputs",
        )?;
        compatible(
            ports(binding, "outputs")?.or(outs),
            ports(exec, "outputs")?,
            "outputs",
        )?;
        let refs = common
            .iter()
            .chain(array(binding, "resources")?)
            .chain(array(exec, "resources")?);
        let deps = resources(db, text(exec, "kind")?, refs, &mut budget)?;
        let mut target = json!({"id":id,"revision":rev,"kind":exec["kind"]});
        if let Some(env) = exec.get("environment") {
            target["environment"] = env.clone();
        }
        if exec["kind"] == "flow" {
            target["flowId"] = exec["flowId"].clone();
            target["flowRevision"] = exec["flowRevision"].clone();
        }
        frozen.insert(action.clone(), json!({"executor":target,"resources":deps}));
    }
    let mut snapshot = b.clone();
    snapshot["actions"] = Value::Object(frozen);
    Ok(snapshot)
}
