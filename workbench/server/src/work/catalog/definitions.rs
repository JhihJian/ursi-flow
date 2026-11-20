//! 资源与执行器发布请求、配置字段和版本引用校验。
use super::{Error, require_active, version};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

pub(super) fn fields(v: &Value, allowed: &[&str]) -> Result<(), Error> {
    let obj = v
        .as_object()
        .ok_or_else(|| Error::Invalid("需要 JSON 对象".into()))?;
    if obj.keys().any(|k| !allowed.contains(&k.as_str())) {
        return Err(Error::Invalid("定义含有不支持的字段".into()));
    }
    Ok(())
}
pub(super) fn text<'a>(v: &'a Value, k: &str) -> Result<&'a str, Error> {
    v[k].as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| Error::Invalid(format!("{k} 必须是非空字符串")))
}
pub(super) fn name(s: &str) -> Result<&str, Error> {
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

fn validate_default(ty: &str, value: &Value, field: &Map<String, Value>) -> Result<(), Error> {
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
        "enum" => field["options"].as_array().is_some_and(|options| {
            options
                .iter()
                .any(|option| option.get("value") == Some(value))
        }),
        "configPackage" => value.as_str().is_some_and(|id| name(id).is_ok()),
        "integer" => value.as_i64().is_some() || value.as_u64().is_some(),
        "number" => value.as_f64().is_some_and(f64::is_finite),
        "boolean" => value.is_boolean(),
        _ => false,
    };
    valid
        .then_some(())
        .ok_or_else(|| Error::Invalid(format!("{ty} 的 default 类型无效")))
}

fn validate_config_schema(v: &Value) -> Result<Value, Error> {
    let wrapped = v.is_object();
    if wrapped {
        fields(v, &["fields"])?;
    }
    let fields_list = v
        .as_array()
        .or_else(|| v.get("fields").and_then(Value::as_array))
        .ok_or_else(|| Error::Invalid("configSchema 必须是字段定义数组".into()))?;
    let mut seen = BTreeMap::new();
    let mut normalized = Vec::with_capacity(fields_list.len());
    for (index, raw) in fields_list.iter().enumerate() {
        let field = raw
            .as_object()
            .ok_or_else(|| Error::Invalid(format!("configSchema[{index}] 必须是对象")))?;
        fields(
            &Value::Object(field.clone()),
            &[
                "key",
                "label",
                "description",
                "type",
                "required",
                "default",
                "options",
                "min",
                "max",
            ],
        )?;
        let key = field
            .get("key")
            .and_then(Value::as_str)
            .ok_or_else(|| Error::Invalid(format!("configSchema[{index}].key 无效")))?;
        name(key)?;
        if seen.insert(key, ()).is_some() {
            return Err(Error::Invalid(format!("configSchema.{key} 不能重复")));
        }
        let label = field
            .get("label")
            .and_then(Value::as_str)
            .filter(|label| !label.trim().is_empty())
            .ok_or_else(|| Error::Invalid(format!("configSchema.{key}.label 必须是非空字符串")))?;
        let ty = field
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| Error::Invalid(format!("configSchema.{key}.type 无效")))?;
        if !matches!(
            ty,
            "string"
                | "url"
                | "secret"
                | "enum"
                | "integer"
                | "number"
                | "boolean"
                | "configPackage"
        ) {
            return Err(Error::Invalid(format!("configSchema.{key}.type 不受支持")));
        }
        if let Some(description) = field.get("description") {
            if !description.is_string() {
                return Err(Error::Invalid(format!(
                    "configSchema.{key}.description 必须是字符串"
                )));
            }
        }
        if let Some(required) = field.get("required") {
            if !required.is_boolean() {
                return Err(Error::Invalid(format!(
                    "configSchema.{key}.required 必须是布尔值"
                )));
            }
        }
        match ty {
            "integer" => {
                let min = field.get("min").map(|v| integer(v, "min")).transpose()?;
                let max = field.get("max").map(|v| integer(v, "max")).transpose()?;
                if let (Some(min), Some(max)) = (min, max) {
                    if min > max {
                        return Err(Error::Invalid(format!("configSchema.{key} 数值边界无效")));
                    }
                }
            }
            "number" => {
                let min = field.get("min").map(|v| number(v, "min")).transpose()?;
                let max = field.get("max").map(|v| number(v, "max")).transpose()?;
                if let (Some(min), Some(max)) = (min, max) {
                    if min > max {
                        return Err(Error::Invalid(format!("configSchema.{key} 数值边界无效")));
                    }
                }
            }
            _ if field.contains_key("min") || field.contains_key("max") => {
                return Err(Error::Invalid(format!("{ty} 不支持数值边界")));
            }
            _ => {}
        }
        match ty {
            "enum" => {
                let options = field
                    .get("options")
                    .and_then(Value::as_array)
                    .filter(|v| !v.is_empty())
                    .ok_or_else(|| {
                        Error::Invalid(format!("configSchema.{key}.options 必须是非空数组"))
                    })?;
                let mut option_keys = BTreeMap::new();
                for option in options {
                    let option = option.as_object().ok_or_else(|| {
                        Error::Invalid(format!("configSchema.{key}.options 必须是对象数组"))
                    })?;
                    fields(&Value::Object(option.clone()), &["value", "label"])?;
                    let value = option
                        .get("value")
                        .and_then(Value::as_str)
                        .filter(|v| !v.trim().is_empty())
                        .ok_or_else(|| {
                            Error::Invalid(format!("configSchema.{key}.options.value 无效"))
                        })?;
                    if option
                        .get("label")
                        .and_then(Value::as_str)
                        .is_none_or(|v| v.trim().is_empty())
                    {
                        return Err(Error::Invalid(format!(
                            "configSchema.{key}.options.label 无效"
                        )));
                    }
                    if option_keys.insert(value, ()).is_some() {
                        return Err(Error::Invalid(format!(
                            "configSchema.{key}.options 不能重复"
                        )));
                    }
                }
            }
            "configPackage" => {
                if field.contains_key("options") {
                    return Err(Error::Invalid("configPackage 不接受 options".into()));
                }
            }
            _ if field.contains_key("options") => {
                return Err(Error::Invalid(format!("{ty} 不支持 options")));
            }
            _ => {}
        }
        if let Some(default) = field.get("default") {
            validate_default(ty, default, field)?;
            let outside = match ty {
                "integer" => {
                    let value = integer(default, "default")?;
                    let min = field.get("min").map(|v| integer(v, "min")).transpose()?;
                    let max = field.get("max").map(|v| integer(v, "max")).transpose()?;
                    min.is_some_and(|bound| value < bound) || max.is_some_and(|bound| value > bound)
                }
                "number" => {
                    let value = number(default, "default")?;
                    let min = field.get("min").map(|v| number(v, "min")).transpose()?;
                    let max = field.get("max").map(|v| number(v, "max")).transpose()?;
                    min.is_some_and(|bound| value < bound) || max.is_some_and(|bound| value > bound)
                }
                _ => false,
            };
            if outside {
                return Err(Error::Invalid(format!(
                    "configSchema.{key}.default 超出数值边界"
                )));
            }
        }
        let _ = label;
        normalized.push(Value::Object(field.clone()));
    }
    if wrapped {
        Ok(json!({"fields": normalized}))
    } else {
        Ok(Value::Array(normalized))
    }
}

fn executor(db: &Value, b: &Value) -> Result<Value, Error> {
    fields(b, &["id", "resources", "configSchema"])?;
    let mut value = b.clone();
    if let Some(schema) = b.get("configSchema") {
        value["configSchema"] = validate_config_schema(schema)?;
    }
    resolve_resources(db, b)?;
    Ok(value)
}

pub(super) fn resolve_resources<'a>(
    db: &'a Value,
    definition: &Value,
) -> Result<Vec<&'a Value>, Error> {
    let refs = array(definition, "resources")?;
    let mut resolved = Vec::new();
    let mut seen = BTreeMap::new();
    let mut budget: usize = 2 * 1024 * 1024;
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
        budget = budget
            .checked_sub(size)
            .ok_or_else(|| Error::Invalid("展开的资源超过 2 MiB".into()))?;
        resolved.push(v);
    }
    Ok(resolved)
}
