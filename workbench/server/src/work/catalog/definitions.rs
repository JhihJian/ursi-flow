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

fn is_url(s: &str) -> bool {
    let Some((scheme, rest)) = s.split_once("://") else {
        return false;
    };
    let valid_scheme = scheme
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic())
        && scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'));
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    valid_scheme
        && !authority.is_empty()
        && !authority.starts_with([':', '@'])
        && !authority
            .chars()
            .any(|c| c.is_whitespace() || c.is_control())
        && !rest.chars().any(char::is_control)
}

fn number(v: &Value, field: &str) -> Result<f64, Error> {
    v.as_f64()
        .filter(|n| n.is_finite())
        .ok_or_else(|| Error::Invalid(format!("{field} 必须是有限数字")))
}

fn integer(v: &Value, field: &str) -> Result<i128, Error> {
    v.as_i64()
        .map(i128::from)
        .or_else(|| v.as_u64().map(i128::from))
        .ok_or_else(|| Error::Invalid(format!("{field} 必须是整数")))
}

fn secret_reference(s: &str) -> bool {
    let Some(reference) = s.strip_prefix("secret://") else {
        return false;
    };
    !reference.is_empty()
        && !reference.starts_with('/')
        && !reference
            .chars()
            .any(|c| c.is_whitespace() || c.is_control())
}

fn validate_default(ty: &str, value: &Value, schema: &Map<String, Value>) -> Result<(), Error> {
    let valid = match ty {
        "string" => value.is_string(),
        "url" => value.as_str().is_some_and(is_url),
        "secret" => {
            value == "***"
                || value.as_object().is_some_and(|v| {
                    v.len() == 1
                        && v.get("ref")
                            .and_then(Value::as_str)
                            .is_some_and(secret_reference)
                })
                || value
                    .as_object()
                    .is_some_and(|v| v.len() == 1 && v.get("redacted") == Some(&Value::Bool(true)))
        }
        "enum" => schema["values"]
            .as_array()
            .is_some_and(|values| values.iter().any(|candidate| candidate == value)),
        "integer" => value.as_i64().is_some() || value.as_u64().is_some(),
        "number" => value.as_f64().is_some_and(f64::is_finite),
        "boolean" => value.is_boolean(),
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(Error::Invalid(format!("{ty} 的 default 类型无效")))
    }
}

fn validate_config_schema(v: &Value) -> Result<Value, Error> {
    let schema = v
        .as_object()
        .ok_or_else(|| Error::Invalid("configSchema 必须是字段定义对象".into()))?;
    let mut normalized = Map::new();
    for (field, definition) in schema {
        name(field)?;
        let definition = definition
            .as_object()
            .ok_or_else(|| Error::Invalid(format!("configSchema.{field} 必须是对象")))?;
        fields(
            &Value::Object(definition.clone()),
            &["type", "default", "values", "minimum", "maximum"],
        )?;
        let ty = definition
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| Error::Invalid(format!("configSchema.{field}.type 无效")))?;
        if !matches!(
            ty,
            "string" | "url" | "secret" | "enum" | "integer" | "number" | "boolean"
        ) {
            return Err(Error::Invalid(format!(
                "configSchema.{field}.type 不受支持"
            )));
        }

        let has_bounds = definition.contains_key("minimum") || definition.contains_key("maximum");
        if ty != "integer" && ty != "number" && has_bounds {
            return Err(Error::Invalid(format!("{ty} 不支持数值边界")));
        }
        let (minimum, maximum) = match ty {
            "integer" => {
                let minimum = definition
                    .get("minimum")
                    .map(|v| integer(v, "minimum"))
                    .transpose()?;
                let maximum = definition
                    .get("maximum")
                    .map(|v| integer(v, "maximum"))
                    .transpose()?;
                if let (Some(minimum), Some(maximum)) = (minimum, maximum) {
                    if minimum > maximum {
                        return Err(Error::Invalid(format!("configSchema.{field} 数值边界无效")));
                    }
                }
                (None, None)
            }
            "number" => {
                let minimum = definition
                    .get("minimum")
                    .map(|v| number(v, "minimum"))
                    .transpose()?;
                let maximum = definition
                    .get("maximum")
                    .map(|v| number(v, "maximum"))
                    .transpose()?;
                if let (Some(minimum), Some(maximum)) = (minimum, maximum) {
                    if minimum > maximum {
                        return Err(Error::Invalid(format!("configSchema.{field} 数值边界无效")));
                    }
                }
                (minimum, maximum)
            }
            _ => (None, None),
        };

        if ty == "enum" {
            let values = definition
                .get("values")
                .and_then(Value::as_array)
                .filter(|values| !values.is_empty())
                .ok_or_else(|| {
                    Error::Invalid(format!("configSchema.{field}.values 必须是非空数组"))
                })?;
            let mut seen = BTreeMap::new();
            for value in values {
                let value = value
                    .as_str()
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| {
                        Error::Invalid(format!("configSchema.{field}.values 必须是字符串"))
                    })?;
                if seen.insert(value, ()).is_some() {
                    return Err(Error::Invalid(format!(
                        "configSchema.{field}.values 不能重复"
                    )));
                }
            }
        } else if definition.contains_key("values") {
            return Err(Error::Invalid(format!("{ty} 不支持 values")));
        }

        if let Some(default) = definition.get("default") {
            validate_default(ty, default, definition)?;
            let out_of_bounds = match ty {
                "integer" => {
                    let value = integer(default, "default")?;
                    let minimum = definition
                        .get("minimum")
                        .map(|v| integer(v, "minimum"))
                        .transpose()?;
                    let maximum = definition
                        .get("maximum")
                        .map(|v| integer(v, "maximum"))
                        .transpose()?;
                    minimum.is_some_and(|bound| value < bound)
                        || maximum.is_some_and(|bound| value > bound)
                }
                "number" => {
                    let value = number(default, "default")?;
                    minimum.is_some_and(|bound| value < bound)
                        || maximum.is_some_and(|bound| value > bound)
                }
                _ => false,
            };
            if out_of_bounds {
                return Err(Error::Invalid(format!(
                    "configSchema.{field}.default 超出数值边界"
                )));
            }
        }
        normalized.insert(field.clone(), Value::Object(definition.clone()));
    }
    Ok(Value::Object(normalized))
}

fn executor(db: &Value, b: &Value) -> Result<Value, Error> {
    fields(b, &["id", "resources", "configSchema"])?;
    let deps = array(b, "resources")?;
    let mut value = b.clone();
    if let Some(schema) = b.get("configSchema") {
        value["configSchema"] = validate_config_schema(schema)?;
    }
    let mut budget = MAX_SNAPSHOT_BYTES;
    resources(db, deps.iter(), &mut budget)?;
    Ok(value)
}

// Expanded references must not turn a tiny publish request into an unbounded snapshot.
const MAX_SNAPSHOT_BYTES: usize = 2 * 1024 * 1024;
fn resources<'a>(
    db: &Value,
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
        if v["kind"] == "mcp" {
            return Err(Error::Invalid(format!("执行器暂不支持注入 MCP 资源 {id}")));
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
    ports(b, "inputs")?;
    ports(b, "outputs")?;
    let actions = b["actions"]
        .as_object()
        .filter(|m| !m.is_empty())
        .ok_or_else(|| Error::Invalid("工作包需要至少一个 action".into()))?;
    let mut frozen = Map::new();
    let mut budget = MAX_SNAPSHOT_BYTES;
    for (action, binding) in actions {
        name(action)?;
        fields(binding, &["executor", "resources", "inputs", "outputs"])?;
        ports(binding, "inputs")?;
        ports(binding, "outputs")?;
        let (id, rev) = reference(&binding["executor"])?;
        require_active(db, "executors", id)?;
        let exec = version(db, "executors", id, rev)?;
        let refs = common
            .iter()
            .chain(array(binding, "resources")?)
            .chain(array(exec, "resources")?);
        let deps = resources(db, refs, &mut budget)?;
        let mut target = json!({"id":id,"revision":rev});
        if let Some(schema) = exec.get("configSchema") {
            target["configSchema"] = schema.clone();
        }
        frozen.insert(action.clone(), json!({"executor":target,"resources":deps}));
    }
    let mut snapshot = b.clone();
    snapshot["actions"] = Value::Object(frozen);
    Ok(snapshot)
}
