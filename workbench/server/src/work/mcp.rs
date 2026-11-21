//! Workbench adapters: all record and credential access goes through the existing Store lock.
use super::{Error, Store, environment};
use serde_json::{Value, json};
use std::sync::Arc;
use ursi_mcp::{
    Credentials, Error as McpError, MAX_SERVERS, McpPlatform, ServerRecord, ServerRepository,
    Settings,
};
const TABLE: &str = "mcpServers";

pub(super) fn platform(store: &Store) -> McpPlatform {
    let adapter = Arc::new(store.clone());
    McpPlatform::new(
        adapter.clone(),
        adapter,
        store.dir().join("mcp-policy.json"),
        "ursi-workbench",
        env!("CARGO_PKG_VERSION"),
    )
}
impl From<Error> for McpError {
    fn from(e: Error) -> Self {
        match e {
            Error::Invalid(s) => Self::Invalid(s),
            Error::NotFound(s) => Self::NotFound(s),
            Error::Unavailable(s) => Self::Unavailable(s),
            Error::Internal(s) | Error::Conflict(s) => Self::Internal(s),
        }
    }
}
impl From<McpError> for Error {
    fn from(e: McpError) -> Self {
        match e {
            McpError::Invalid(s) => Self::Invalid(s),
            McpError::NotFound(s) => Self::NotFound(s),
            McpError::Unavailable(s) => Self::Unavailable(s),
            McpError::Internal(s) => Self::Internal(s),
        }
    }
}
impl Credentials for Store {
    fn lookup(&self, name: &str) -> Result<Option<String>, McpError> {
        Ok(environment::lookup(self, name)?)
    }
}
fn decode(row: &Value) -> Result<ServerRecord, Error> {
    serde_json::from_value(row.clone()).map_err(|_| Error::Internal("MCP 服务记录损坏".into()))
}
impl ServerRepository for Store {
    fn list(&self) -> Result<Vec<ServerRecord>, McpError> {
        Ok(self.read(|db| match db.get(TABLE) {
            None => Ok(vec![]),
            Some(rows) => rows
                .as_object()
                .ok_or_else(|| Error::Internal("MCP 服务表损坏".into()))?
                .values()
                .map(decode)
                .collect(),
        })?)
    }
    fn get(&self, id: &str) -> Result<Option<ServerRecord>, McpError> {
        Ok(self.read(|db| db[TABLE].get(id).map(decode).transpose())?)
    }
    fn insert(&self, row: &ServerRecord) -> Result<(), McpError> {
        Ok(self.update(|db| {
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
        })?)
    }
    fn remove(&self, id: &str) -> Result<bool, McpError> {
        Ok(self.update(|db| {
            Ok(db
                .get_mut(TABLE)
                .and_then(Value::as_object_mut)
                .and_then(|rows| rows.remove(id))
                .is_some())
        })?)
    }
    fn replace_settings(&self, id: &str, settings: &Settings) -> Result<bool, McpError> {
        Ok(self.update(|db| {
            let Some(row) = db.get_mut(TABLE).and_then(|t| t.get_mut(id)) else {
                return Ok(false);
            };
            row["settings"] = json!(settings);
            Ok(true)
        })?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn existing_records_and_settings_survive_reopen() {
        let dir = std::env::temp_dir().join(format!("ursi-mcp-store-{}", uuid::Uuid::new_v4()));
        let store = Store::open(dir.clone()).unwrap();
        let row = json!({"id":"old-id","name":"旧登记","url":"https://example.org/mcp","settings":{"allowedTools":["echo"],"githubToolsets":[],"githubReadOnly":false}});
        store
            .update(|db| {
                db[TABLE] = json!({"old-id":row.clone()});
                Ok(())
            })
            .unwrap();
        drop(store);

        let store = Store::open(dir.clone()).unwrap();
        assert_eq!(json!(platform(&store).list().unwrap()), json!([row]));
        assert!(
            ServerRepository::replace_settings(&store, "old-id", &Settings::default()).unwrap()
        );
        drop(store);

        let store = Store::open(dir.clone()).unwrap();
        let mut expected = row;
        expected["settings"] = json!(Settings::default());
        assert_eq!(json!(platform(&store).list().unwrap()), json!([expected]));
        drop(store);
        fs::remove_dir_all(dir).unwrap();
    }
}
