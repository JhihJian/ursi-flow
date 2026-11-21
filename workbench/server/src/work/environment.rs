//! 平台变量只在授权的消费点按名读取，不修改或枚举进程环境。
use super::{Error, Store};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, State, rejection::JsonRejection},
    routing::{get, put},
};
use serde::Deserialize;
use serde_json::{Map, Value, json};

const TABLE: &str = "platformEnvironment";
const MAX_VALUE: usize = 8192;

pub(super) fn valid_name(name: &str) -> bool {
    name.len() <= 128
        && name.as_bytes().first().is_some_and(u8::is_ascii_uppercase)
        && name
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
}
fn check_name(name: &str) -> Result<(), Error> {
    if valid_name(name) {
        Ok(())
    } else {
        Err(Error::Invalid(
            "变量名须以大写字母开头，仅含大写字母、数字和下划线，最长 128 个字符".into(),
        ))
    }
}
fn damaged() -> Error {
    Error::Internal("平台环境变量表损坏".into())
}
fn rows(db: &Value) -> Result<Option<&Map<String, Value>>, Error> {
    db.get(TABLE)
        .map(|v| v.as_object().ok_or_else(damaged))
        .transpose()
}
pub(super) fn lookup(store: &Store, name: &str) -> Result<Option<String>, Error> {
    store.read(|db| {
        rows(db)?
            .and_then(|r| r.get(name))
            .map(|v| v.as_str().map(str::to_owned).ok_or_else(damaged))
            .transpose()
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Create {
    name: String,
    value: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Replacement {
    value: String,
}
// Typed JSON rejection details can include the submitted credential.
fn payload<T>(input: Result<Json<T>, JsonRejection>) -> Result<T, Error> {
    input
        .map(|Json(v)| v)
        .map_err(|_| Error::Invalid("无效的环境变量请求".into()))
}
pub(super) fn routes(store: Store) -> Router {
    Router::new()
        .route("/v2/platform-env", get(list).post(create))
        .route("/v2/platform-env/{name}", put(replace).delete(remove))
        .layer(DefaultBodyLimit::max(64 * 1024))
        .with_state(store)
}
async fn list(State(store): State<Store>) -> Result<Json<Vec<String>>, Error> {
    store.read(|db| {
        Ok(Json(
            rows(db)?
                .into_iter()
                .flat_map(|r| r.keys().cloned())
                .collect(),
        ))
    })
}
async fn create(
    State(store): State<Store>,
    input: Result<Json<Create>, JsonRejection>,
) -> Result<Json<Value>, Error> {
    let Create { name, value } = payload(input)?;
    save(&store, name, value, false)
}
async fn replace(
    State(store): State<Store>,
    Path(name): Path<String>,
    input: Result<Json<Replacement>, JsonRejection>,
) -> Result<Json<Value>, Error> {
    save(&store, name, payload(input)?.value, true)
}
fn missing() -> Error {
    Error::NotFound("平台环境变量不存在".into())
}
fn save(store: &Store, name: String, value: String, replace: bool) -> Result<Json<Value>, Error> {
    check_name(&name)?;
    if value.is_empty() || value.len() > MAX_VALUE || value.contains('\0') {
        return Err(Error::Invalid(
            "变量值须为 1 至 8192 字节，且不能含空字符".into(),
        ));
    }
    store.update(|db| {
        let r = db
            .as_object_mut()
            .unwrap()
            .entry(TABLE)
            .or_insert_with(|| json!({}))
            .as_object_mut()
            .ok_or_else(damaged)?;
        match (replace, r.contains_key(&name)) {
            (true, false) => return Err(missing()),
            (false, true) => return Err(Error::Conflict("平台环境变量已存在".into())),
            (false, false) if r.len() >= 128 => {
                return Err(Error::Invalid("最多设置 128 个平台环境变量".into()));
            }
            _ => (),
        }
        r.insert(name.clone(), Value::String(value));
        Ok(Json(json!({"name":name})))
    })
}
async fn remove(
    State(store): State<Store>,
    Path(name): Path<String>,
) -> Result<Json<Value>, Error> {
    check_name(&name)?;
    store.update(|db| {
        db.get_mut(TABLE)
            .ok_or_else(missing)?
            .as_object_mut()
            .ok_or_else(damaged)?
            .remove(&name)
            .ok_or_else(missing)?;
        Ok(Json(json!({"name":name})))
    })
}
