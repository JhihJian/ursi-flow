//! Workbench adapters: all record and credential access goes through the existing Store lock.
use super::{Error, Store, environment};
use serde_json::{Value, json};
use std::sync::Arc;
use ursi_mcp::{
    Binding, Credentials, Error as McpError, MAX_SERVERS, McpPlatform, ProtocolCheck, RecognitionRule,
    ServerRecord, ServerRepository, Settings, default_recognition_rules,
};
const TABLE: &str = "mcpServers";
const RULES: &str = "mcpRecognitionRules";

struct Adapter(Store);

pub(super) fn platform(store: &Store) -> McpPlatform {
    let adapter = Arc::new(Adapter(store.clone()));
    McpPlatform::new(
        adapter.clone(),
        adapter,
        store.dir().join("mcp-policy.json"),
        "ursi-workbench",
        env!("CARGO_PKG_VERSION"),
    )
}
fn to_mcp_error(error: Error) -> McpError {
    match error {
        Error::Invalid(s) => McpError::Invalid(s),
        Error::NotFound(s) => McpError::NotFound(s),
        Error::Unavailable(s) => McpError::Unavailable(s),
        Error::Internal(s) | Error::Conflict(s) => McpError::Internal(s),
    }
}
pub(super) fn from_mcp_error(error: McpError) -> Error {
    match error {
        McpError::Invalid(s) => Error::Invalid(s),
        McpError::NotFound(s) => Error::NotFound(s),
        McpError::Unavailable(s) => Error::Unavailable(s),
        McpError::Internal(s) => Error::Internal(s),
    }
}
impl Credentials for Adapter {
    fn lookup(&self, name: &str, binding: Binding) -> Result<Option<String>, McpError> {
        let managed = environment::lookup(&self.0, name).map_err(to_mcp_error)?;
        Ok(managed.or_else(|| {
            (binding == Binding::Policy)
                .then(|| std::env::var(name).ok())
                .flatten()
        }))
    }
}
fn decode(row: &Value) -> Result<ServerRecord, Error> {
    serde_json::from_value(row.clone()).map_err(|_| Error::Internal("MCP 服务记录损坏".into()))
}
impl ServerRepository for Adapter {
    fn list(&self) -> Result<Vec<ServerRecord>, McpError> {
        self.0
            .read(|db| match db.get(TABLE) {
                None => Ok(vec![]),
                Some(rows) => rows
                    .as_object()
                    .ok_or_else(|| Error::Internal("MCP 服务表损坏".into()))?
                    .values()
                    .map(decode)
                    .collect(),
            })
            .map_err(to_mcp_error)
    }
    fn get(&self, id: &str) -> Result<Option<ServerRecord>, McpError> {
        self.0
            .read(|db| db[TABLE].get(id).map(decode).transpose())
            .map_err(to_mcp_error)
    }
    fn insert(&self, row: &ServerRecord) -> Result<(), McpError> {
        self.0
            .update(|db| {
                let rows = db
                    .as_object_mut()
                    .unwrap()
                    .entry(TABLE)
                    .or_insert_with(|| json!({}))
                    .as_object_mut()
                    .ok_or_else(|| Error::Internal("MCP 服务表损坏".into()))?;
                if rows.len() >= MAX_SERVERS {
                    return Err(Error::Invalid("最多登记 128 个 MCP 服务".into()));
                }
                rows.insert(row.id.clone(), json!(row));
                Ok(())
            })
            .map_err(to_mcp_error)
    }
    fn remove(&self, id: &str) -> Result<bool, McpError> {
        self.0
            .update(|db| {
                Ok(db
                    .get_mut(TABLE)
                    .and_then(Value::as_object_mut)
                    .and_then(|rows| rows.remove(id))
                    .is_some())
            })
            .map_err(to_mcp_error)
    }
    fn replace_settings(&self, id: &str, settings: &Settings) -> Result<bool, McpError> {
        self.0
            .update(|db| {
                let Some(row) = db.get_mut(TABLE).and_then(|t| t.get_mut(id)) else {
                    return Ok(false);
                };
                row["settings"] = json!(settings);
                Ok(true)
            })
            .map_err(to_mcp_error)
    }
    fn record_protocol_check(&self, id: &str, check: &ProtocolCheck) -> Result<bool, McpError> {
        self.0
            .update(|db| {
                let Some(row) = db.get_mut(TABLE).and_then(|t| t.get_mut(id)) else {
                    return Ok(false);
                };
                row["protocolCheck"] = json!(check);
                Ok(true)
            })
            .map_err(to_mcp_error)
    }
    fn recognition_rules(&self) -> Result<Vec<RecognitionRule>, McpError> {
        self.0
            .read(|db| match db.get(RULES) {
                None => Ok(default_recognition_rules()),
                Some(value) => serde_json::from_value(value.clone())
                    .map_err(|_| Error::Internal("识别规则数据损坏".into())),
            })
            .map_err(to_mcp_error)
    }
    fn replace_recognition_rules(&self, rules: &[RecognitionRule]) -> Result<(), McpError> {
        self.0
            .update(|db| {
                db.as_object_mut()
                    .ok_or_else(|| Error::Internal("业务库损坏".into()))?
                    .insert(RULES.into(), json!(rules));
                let rows = db.get_mut(TABLE).and_then(Value::as_object_mut);
                if let Some(rows) = rows {
                    for row in rows.values_mut() {
                        if let Some(obj) = row.as_object_mut() {
                            obj.remove("protocolCheck");
                        }
                    }
                }
                Ok(())
            })
            .map_err(to_mcp_error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn rules_and_legacy_protocol_checks_survive_reopen_or_drop() {
        let dir = std::env::temp_dir().join(format!("ursi-mcp-store-{}", uuid::Uuid::new_v4()));
        let store = Store::open(dir.clone()).unwrap();
        let row = json!({"id":"old-id","name":"旧登记","url":"https://example.org/mcp","settings":{"allowedTools":["echo"],"githubToolsets":[],"githubReadOnly":false},"protocolCheck":{"status":"declaredV1","checkedAt":1}});
        store
            .update(|db| {
                db[TABLE] = json!({"old-id":row.clone()});
                Ok(())
            })
            .unwrap();
        drop(store);

        let store = Store::open(dir.clone()).unwrap();
        let listed = json!(platform(&store).list().unwrap());
        assert!(listed[0].get("protocolCheck").is_none(), "旧检查无标签，丢弃");
        assert_eq!(listed[0]["id"], "old-id");
        let rules = platform(&store).recognition_rules().unwrap();
        assert_eq!(rules, default_recognition_rules());
        let check = ProtocolCheck {
            status: ursi_mcp::ProtocolStatus::Checked,
            checked_at: 1,
            labels: vec!["执行器 v1".into()],
        };
        let adapter = Adapter(store);
        assert!(adapter.record_protocol_check("old-id", &check).unwrap());
        assert!(
            adapter
                .replace_settings("old-id", &Settings::default())
                .unwrap()
        );
        assert!(adapter.replace_recognition_rules(&[]).is_ok());
        drop(adapter);

        let store = Store::open(dir.clone()).unwrap();
        assert!(platform(&store).recognition_rules().unwrap().is_empty());
        let mut expected = row;
        expected["settings"] = json!(Settings::default());
        expected
            .as_object_mut()
            .unwrap()
            .remove("protocolCheck");
        assert_eq!(json!(platform(&store).list().unwrap()), json!([expected]));
        drop(store);
        fs::remove_dir_all(dir).unwrap();
    }
}
