use super::{Error, catalog::validate_delivery_name};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Create {
    request_id: String,
    package: String,
    revision: u64,
    input: Map<String, Value>,
    #[serde(default = "builtin")]
    pub(super) source: Map<String, Value>,
}

fn builtin() -> Map<String, Value> {
    Map::from_iter([("type".into(), "builtin".into())])
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Start {
    assignee: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Delivery {
    files: BTreeMap<String, String>,
    #[serde(default)]
    attempt_ids: Vec<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Decision {
    Accept,
    Reject,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Review {
    reviewer: String,
    decision: Decision,
    #[serde(default)]
    comment: String,
}

fn required(s: &str, field: &str) -> Result<(), Error> {
    if s.trim().is_empty() {
        return Err(Error::Invalid(format!("{field} is required")));
    }
    Ok(())
}

fn missing(id: &str) -> Error {
    Error::NotFound(format!("item {id} not found"))
}

pub(super) fn item<'a>(db: &'a Value, id: &str) -> Result<&'a Value, Error> {
    db["items"].get(id).ok_or_else(|| missing(id))
}

pub(super) fn item_mut<'a>(db: &'a mut Value, id: &str) -> Result<&'a mut Value, Error> {
    db.get_mut("items")
        .and_then(|items| items.get_mut(id))
        .ok_or_else(|| missing(id))
}

fn items(db: &Value) -> Result<impl Iterator<Item = &Value>, Error> {
    let map = db
        .get("items")
        .map(|v| {
            v.as_object()
                .ok_or_else(|| Error::Internal("invalid items dictionary".into()))
        })
        .transpose()?;
    Ok(map.into_iter().flat_map(Map::values))
}

fn validate_input(snapshot: &Value, input: &Value) -> Result<(), Error> {
    let Some(types) = snapshot.get("inputs") else {
        return Ok(());
    };
    let types = types
        .as_object()
        .ok_or_else(|| Error::Internal("invalid package input declarations".into()))?;
    for (key, ty) in types {
        let value = input
            .get(key)
            .ok_or_else(|| Error::Invalid(format!("missing input: {key}")))?;
        let matches = match ty.as_str() {
            Some("string") => value.is_string(),
            Some("number") => value.is_number(),
            Some("integer") => value.is_i64() || value.is_u64(),
            Some("boolean") => value.is_boolean(),
            Some("array") => value.is_array(),
            Some("object") => value.is_object(),
            _ => return Err(Error::Internal("unknown package input type".into())),
        };
        if !matches {
            return Err(Error::Invalid(format!("input {key} must be {ty}")));
        }
    }
    Ok(())
}

pub(super) fn create(
    db: &mut Value,
    req: Create,
    resolve: impl FnOnce(&Value, &str, u64) -> Result<Value, Error>,
) -> Result<Value, Error> {
    required(&req.request_id, "requestId")?;
    required(&req.package, "package")?;
    let source = Value::Object(req.source);
    let input = Value::Object(req.input);
    for old in items(db)? {
        if old["requestId"] != req.request_id {
            continue;
        }
        if old["package"] == req.package
            && old["revision"] == req.revision
            && old["source"] == source
            && old["input"] == input
        {
            return Ok(old.clone());
        }
        return Err(Error::Conflict(
            "requestId already used with different parameters".into(),
        ));
    }
    let snapshot = resolve(db, &req.package, req.revision)?;
    validate_input(&snapshot, &input)?;
    let id = Uuid::new_v4().to_string();
    let item = json!({"id":id,"requestId":req.request_id,"package":req.package,"revision":req.revision,
        "packageSnapshot":snapshot,"source":source,"input":input,"status":"pending","assignee":null,
        "attempts":[],"deliveries":[],"acceptedVersion":null});
    db["items"][&id] = item.clone();
    Ok(item)
}

pub(super) fn list(db: &Value, status: Option<&str>) -> Result<Value, Error> {
    if !matches!(
        status,
        None | Some("pending" | "working" | "review" | "delivered")
    ) {
        return Err(Error::Invalid("unknown item status".into()));
    }
    let summaries: Vec<_> = items(db)?
        .filter(|item| status.is_none_or(|s| item["status"] == s))
        .map(|item| {
            json!({"id":item["id"], "package":item["package"], "revision":item["revision"],
            "status":item["status"], "source":item["source"], "assignee":item["assignee"]})
        })
        .collect();
    Ok(Value::Array(summaries))
}

fn expect_status(item: &Value, expected: &str) -> Result<(), Error> {
    if item["status"] != expected {
        return Err(Error::Conflict(format!("item must be {expected}")));
    }
    Ok(())
}

pub(super) fn start(item: &mut Value, req: Start) -> Result<Value, Error> {
    expect_status(item, "pending")?;
    required(&req.assignee, "assignee")?;
    item["assignee"] = req.assignee.into();
    item["status"] = "working".into();
    Ok(item.clone())
}

fn deliveries_mut(item: &mut Value) -> Result<&mut Vec<Value>, Error> {
    item.get_mut("deliveries")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| Error::Internal("invalid delivery history".into()))
}

pub(super) fn deliver(item: &mut Value, req: Delivery) -> Result<Value, Error> {
    expect_status(item, "working")?;
    let attempts = item["attempts"]
        .as_array()
        .ok_or_else(|| Error::Internal("invalid attempt history".into()))?;
    if attempts.iter().any(|a| {
        !matches!(
            a["status"].as_str(),
            Some("succeeded" | "failed" | "cancelled")
        )
    }) {
        return Err(Error::Conflict("attempt still active or unverified".into()));
    }
    let mut seen = BTreeSet::new();
    for id in &req.attempt_ids {
        if !seen.insert(id) || !attempts.iter().any(|a| a["id"] == id.as_str()) {
            return Err(Error::Invalid(format!("invalid source attempt {id}")));
        }
    }
    if req.files.is_empty() {
        return Err(Error::Invalid(
            "delivery requires at least one text file".into(),
        ));
    }
    if let Some(required_files) = item["packageSnapshot"].get("deliverables") {
        let names = required_files
            .as_array()
            .ok_or_else(|| Error::Internal("deliverables must be an array of file names".into()))?;
        for entry in names {
            let name = entry.as_str().ok_or_else(|| {
                Error::Internal("invalid required file name in package snapshot".into())
            })?;
            if !req.files.contains_key(name) {
                return Err(Error::Invalid(format!(
                    "missing required delivery file: {name}"
                )));
            }
        }
    }
    for (name, text) in &req.files {
        validate_delivery_name(name)?;
        required(text, name)?;
    }
    let history = deliveries_mut(item)?;
    let version = history.len() + 1;
    history.push(
        json!({"version":version,"attemptIds":req.attempt_ids,"files":req.files,"review":null}),
    );
    item["status"] = "review".into();
    Ok(item.clone())
}

pub(super) fn review(item: &mut Value, version: u64, req: Review) -> Result<Value, Error> {
    expect_status(item, "review")?;
    required(&req.reviewer, "reviewer")?;
    let accepted = matches!(req.decision, Decision::Accept);
    if !accepted {
        required(&req.comment, "rejection comment")?;
    }
    let current = deliveries_mut(item)?
        .last_mut()
        .ok_or_else(|| Error::Internal("missing current delivery".into()))?;
    if current["version"] != version || !current["review"].is_null() {
        return Err(Error::Conflict(
            "delivery is no longer awaiting this review".into(),
        ));
    }
    current["review"] = json!(req);
    if accepted {
        item["acceptedVersion"] = version.into();
    }
    item["status"] = (if accepted { "delivered" } else { "working" }).into();
    Ok(item.clone())
}

pub(super) fn file<'a>(item: &'a Value, version: u64, name: &str) -> Result<&'a str, Error> {
    item["deliveries"]
        .as_array()
        .and_then(|d| d.iter().find(|v| v["version"] == version))
        .and_then(|d| d["files"].get(name))
        .and_then(Value::as_str)
        .ok_or_else(|| Error::NotFound("delivery file not found".into()))
}
