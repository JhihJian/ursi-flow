//! 可执行工作包的类型目录与不可变 SOP 修订。内置样例无需初始化数据。
use super::{Error, Store};
use axum::{
    Json, Router,
    extract::{Path, State},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};

const TYPE: &str = "finding-report";
const SOP: &str = "receipt";
const DEFAULT_TITLE: &str = "材料接收回执";

pub(super) fn workspace_type(id: &str) -> Result<Value, Error> {
    if id != TYPE {
        return Err(Error::NotFound("工作包类型不存在".into()));
    }
    Ok(
        json!({"id":TYPE,"name":"单条线索报告","roles":[{"id":"finding","label":"Finding"},{"id":"source","label":"源码包"}],"sop":{"id":SOP,"revision":1}}),
    )
}

fn version(id: &str, revision: u64, title: &str) -> Value {
    json!({"id":id,"revision":revision,"executor":"echo","config":{"title":title}})
}

pub(super) fn resolve(db: &Value, id: &str, revision: u64) -> Result<Value, Error> {
    if id == SOP && revision == 1 {
        return Ok(version(SOP, 1, DEFAULT_TITLE));
    }
    db["workspaceSops"][id]
        .get(revision.to_string())
        .cloned()
        .ok_or_else(|| Error::NotFound("SOP 版本不存在".into()))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Definition {
    id: String,
    executor: String,
    config: EchoConfig,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EchoConfig {
    title: String,
}

fn publish(db: &mut Value, d: Definition) -> Result<Value, Error> {
    let id = &d.id;
    if id.is_empty()
        || id.len() > 80
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
    {
        return Err(Error::Invalid(
            "SOP 标识仅支持字母、数字、短横线和下划线".into(),
        ));
    }
    let title = d.config.title.trim();
    if d.executor != "echo"
        || title.is_empty()
        || title.len() > 256
        || title.chars().any(char::is_control)
    {
        return Err(Error::Invalid("需要 echo 执行器和非空单行回执标题".into()));
    }
    let added = db["workspaceSops"][id]
        .as_object()
        .map_or(0, |m| m.len() as u64);
    let revision = added + 1 + u64::from(id == SOP);
    let value = version(id, revision, title);
    db["workspaceSops"][id][revision.to_string()] = value.clone();
    Ok(value)
}

pub(super) fn routes(store: Store) -> Router {
    Router::new()
        .route(
            "/v2/workspace-types",
            get(|| async { workspace_type(TYPE).map(|t| Json(vec![t])) }),
        )
        .route(
            "/v2/sops",
            post(
                |State(s): State<Store>, Json(d): Json<Definition>| async move {
                    s.update(|db| publish(db, d)).map(Json)
                },
            ),
        )
        .route(
            "/v2/sops/{id}/revisions/{revision}",
            get(
                |State(s): State<Store>, Path((id, r)): Path<(String, u64)>| async move {
                    s.read(|db| resolve(db, &id, r)).map(Json)
                },
            ),
        )
        .with_state(store)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fixed_revision_survives_new_publication() {
        let mut db = json!({});
        let make = |id: &str, executor: &str, title: &str| Definition {
            id: id.into(),
            executor: executor.into(),
            config: EchoConfig {
                title: title.into(),
            },
        };
        assert!(publish(&mut db, make(SOP, "shell", "bad")).is_err());
        assert!(publish(&mut db, make(SOP, "echo", "   ")).is_err());
        let v2 = publish(&mut db, make(SOP, "echo", "交接记录")).unwrap();
        assert_eq!(v2["revision"], 2);
        assert_eq!(
            resolve(&db, SOP, 1).unwrap()["config"]["title"],
            DEFAULT_TITLE
        );
        assert_eq!(resolve(&db, SOP, 2).unwrap(), v2);
        assert_eq!(
            publish(&mut db, make("another", "echo", "Another")).unwrap()["revision"],
            1
        );
        assert!(resolve(&db, SOP, 3).is_err());
    }
}
