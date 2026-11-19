//! 工作项办理和交付验收。所有状态检查与相应写入共用一次 Store 更新。
mod model;
#[cfg(test)]
mod tests;

use super::{Error, Store, catalog};
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    routing::{get, post},
};
use model::{Create, Delivery, Review, Start};
use serde::Deserialize;
use serde_json::Value;

type Reply = Result<Json<Value>, Error>;

pub fn routes(store: Store) -> Router {
    Router::new()
        .route("/v2/items", get(list).post(create))
        .route("/v2/items/{id}", get(detail))
        .route("/v2/items/{id}/start", post(start))
        .route("/v2/items/{id}/deliveries", post(deliver))
        .route("/v2/items/{id}/deliveries/{version}/review", post(review))
        .route(
            "/v2/items/{id}/deliveries/{version}/files/{name}",
            get(file),
        )
        .with_state(store)
}

pub(super) fn create_from_source(
    db: &mut Value,
    request_id: &str,
    package: &str,
    revision: u64,
    input: serde_json::Map<String, Value>,
    source: serde_json::Map<String, Value>,
) -> Result<Value, Error> {
    let req = serde_json::from_value(serde_json::json!({"requestId":request_id,"package":package,"revision":revision,"input":input,"source":source})).map_err(|e| Error::Invalid(e.to_string()))?;
    model::create(db, req, |db, p, r| catalog::resolve(db, p, r, true))
}

async fn create(State(store): State<Store>, Json(body): Json<Create>) -> Reply {
    if body.source.get("type").and_then(Value::as_str) == Some("connector") {
        return Err(Error::Invalid("连接器派工须使用来源接口".into()));
    }
    store
        .update(|db| {
            model::create(db, body, |db, package, revision| {
                catalog::resolve(db, package, revision, true)
            })
        })
        .map(Json)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Filter {
    status: Option<String>,
}

async fn list(State(store): State<Store>, Query(filter): Query<Filter>) -> Reply {
    store
        .read(|db| model::list(db, filter.status.as_deref()))
        .map(Json)
}

async fn detail(State(store): State<Store>, Path(id): Path<String>) -> Reply {
    store.read(|db| model::item(db, &id).cloned()).map(Json)
}

async fn start(
    State(store): State<Store>,
    Path(id): Path<String>,
    Json(body): Json<Start>,
) -> Reply {
    store
        .update(|db| model::start(model::item_mut(db, &id)?, body))
        .map(Json)
}

async fn deliver(
    State(store): State<Store>,
    Path(id): Path<String>,
    Json(body): Json<Delivery>,
) -> Reply {
    store
        .update(|db| model::deliver(model::item_mut(db, &id)?, body))
        .map(Json)
}

async fn review(
    State(store): State<Store>,
    Path((id, version)): Path<(String, u64)>,
    Json(body): Json<Review>,
) -> Reply {
    store
        .update(|db| model::review(model::item_mut(db, &id)?, version, body))
        .map(Json)
}

async fn file(
    State(store): State<Store>,
    Path((id, version, name)): Path<(String, u64, String)>,
) -> Result<String, Error> {
    store.read(|db| model::file(model::item(db, &id)?, version, &name).map(str::to_owned))
}
