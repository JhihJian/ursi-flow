//! 可执行工作包的类型目录与不可变 SOP 修订。内置样例无需初始化数据。
use super::{Error, Store};
use axum::{
    Json, Router,
    extract::{Path, State},
    routing::get,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const TYPE: &str = "finding-report";
const SOP: &str = "receipt";
const REVISION: u64 = 1;
const DEFAULT_TITLE: &str = "材料接收回执";

/// SOP 版本引用。类型给出推荐默认值，草稿不保存它，每次执行按需解析。
#[derive(Deserialize, Serialize, Clone, PartialEq, Eq, Debug)]
#[serde(deny_unknown_fields)]
pub(super) struct Reference {
    pub id: String,
    pub revision: u64,
}

pub(super) fn default_reference(type_id: &str) -> Result<Reference, Error> {
    if type_id != TYPE {
        return Err(Error::NotFound("工作包类型不存在".into()));
    }
    Ok(Reference {
        id: SOP.into(),
        revision: REVISION,
    })
}

pub(super) fn workspace_type(id: &str) -> Result<Value, Error> {
    let sop = default_reference(id)?;
    Ok(
        json!({"id":TYPE,"name":"单条线索报告","roles":[{"id":"finding","label":"Finding"},{"id":"source","label":"源码包"}],"sop":sop}),
    )
}

fn version(id: &str, revision: u64, title: &str) -> Value {
    json!({"id":id,"revision":revision,"executor":"echo","config":{"title":title}})
}

pub(super) fn resolve(db: &Value, id: &str, revision: u64) -> Result<Value, Error> {
    if id == SOP && revision == REVISION {
        return Ok(version(SOP, REVISION, DEFAULT_TITLE));
    }
    db.get("workspaceSops")
        .and_then(|sops| sops.get(id))
        .and_then(|revisions| revisions.get(revision.to_string()))
        .cloned()
        .ok_or_else(|| Error::NotFound("SOP 版本不存在".into()))
}

/// 列出全部已发布修订，包含内置版本，按标识和修订号排序。
pub(super) fn published(db: &Value) -> Result<Value, Error> {
    let mut all = vec![(
        SOP.to_owned(),
        REVISION,
        version(SOP, REVISION, DEFAULT_TITLE),
    )];
    let stored = match db.get("workspaceSops") {
        None => None,
        Some(Value::Object(sops)) => Some(sops),
        Some(_) => return Err(Error::Internal("无效的 SOP 目录".into())),
    };
    for (id, revisions) in stored.into_iter().flat_map(|sops| sops.iter()) {
        let revisions = revisions
            .as_object()
            .ok_or_else(|| Error::Internal("无效的 SOP 修订目录".into()))?;
        for (revision, definition) in revisions {
            let revision: u64 = revision
                .parse()
                .map_err(|_| Error::Internal("无效的 SOP 修订号".into()))?;
            if !definition.is_object() {
                return Err(Error::Internal("无效的 SOP 定义".into()));
            }
            all.push((id.clone(), revision, definition.clone()));
        }
    }
    all.sort_by(|a, b| (a.0.as_str(), a.1).cmp(&(b.0.as_str(), b.1)));
    Ok(Value::Array(
        all.into_iter()
            .map(|(_, _, definition)| definition)
            .collect(),
    ))
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
        .route("/v2/workspace-types", get(types))
        .route("/v2/sops", get(list).post(create))
        .route("/v2/sops/{id}/revisions/{revision}", get(read))
        .with_state(store)
}

async fn types() -> Result<Json<Value>, Error> {
    workspace_type(TYPE).map(|ty| Json(Value::Array(vec![ty])))
}

async fn list(State(store): State<Store>) -> Result<Json<Value>, Error> {
    store.read(published).map(Json)
}

async fn create(
    State(store): State<Store>,
    Json(d): Json<Definition>,
) -> Result<Json<Value>, Error> {
    store.update(|db| publish(db, d)).map(Json)
}

async fn read(
    State(store): State<Store>,
    Path((id, revision)): Path<(String, u64)>,
) -> Result<Json<Value>, Error> {
    store.read(|db| resolve(db, &id, revision)).map(Json)
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
        assert_eq!(
            default_reference(TYPE).unwrap(),
            Reference {
                id: SOP.into(),
                revision: REVISION
            }
        );
        assert!(matches!(
            default_reference("other"),
            Err(Error::NotFound(_))
        ));
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

    #[test]
    fn published_lists_the_builtin_and_every_uploaded_revision() {
        let mut db = json!({});
        let make = |id: &str, title: &str| Definition {
            id: id.into(),
            executor: "echo".into(),
            config: EchoConfig {
                title: title.into(),
            },
        };
        assert_eq!(
            published(&json!({})).unwrap(),
            json!([version(SOP, 1, DEFAULT_TITLE)])
        );
        publish(&mut db, make(SOP, "交接记录")).unwrap();
        publish(&mut db, make("another", "Another")).unwrap();
        let all = published(&db).unwrap();
        let listed = all
            .as_array()
            .unwrap()
            .iter()
            .map(|v| {
                (
                    v["id"].as_str().unwrap().to_owned(),
                    v["revision"].as_u64().unwrap(),
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            listed,
            vec![
                ("another".to_owned(), 1),
                (SOP.to_owned(), 1),
                (SOP.to_owned(), 2)
            ]
        );
        db["workspaceSops"][SOP]["broken"] = json!([]);
        assert!(matches!(published(&db), Err(Error::Internal(_))));
    }
}
