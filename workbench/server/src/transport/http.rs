use super::error::Reply;
use crate::flow::FlowService;
use axum::{
    Json, Router,
    extract::{Path, State},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

type Service = State<FlowService>;
type Files = BTreeMap<String, String>;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Package {
    id: String,
    files: Files,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Update {
    files: Files,
    expected_revision: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Start {
    run_id: Option<String>,
    workspace: String,
    variables: Map<String, Value>,
    #[serde(default, deserialize_with = "executor_ref")]
    executor_ref: Option<Value>,
}

fn executor_ref<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Value>, D::Error> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Ref {
        id: String,
        revision: std::num::NonZeroU64,
    }
    let r = Ref::deserialize(d)?;
    if r.id.is_empty() || r.id.trim() != r.id {
        return Err(serde::de::Error::custom("无效的执行器 ID"));
    }
    Ok(Some(json!({"id": r.id, "revision": r.revision})))
}

pub(super) fn routes(service: FlowService) -> Router {
    Router::new()
        .route("/v1/flows", get(flows).post(create))
        // validate 也是合法 Flow ID。静态路径优先匹配，保留此 ID 的资源方法。
        .route(
            "/v1/flows/validate",
            post(validate)
                .get(|s: Service| flow(s, Path("validate".into())))
                .put(|s: Service, b| update(s, Path("validate".into()), b))
                .delete(|s: Service| delete(s, Path("validate".into()))),
        )
        .route("/v1/flows/{id}", get(flow).put(update).delete(delete))
        .route("/v1/flows/{id}/runs", post(start))
        .route("/v1/runs", get(runs))
        .route("/v1/runs/{id}", get(run))
        .route("/v1/runs/{id}/history", get(history))
        .route("/v1/runs/{id}/stop", post(stop))
        .route("/v1/flow-config", get(config).patch(configure))
        .with_state(service)
}

async fn flows(State(s): Service) -> Reply {
    Ok(Json(s.flows().await?))
}
async fn flow(State(s): Service, Path(id): Path<String>) -> Reply {
    Ok(Json(s.flow(id).await?))
}
async fn create(State(s): Service, Json(p): Json<Package>) -> Reply {
    Ok(Json(s.create(p.id, json!(p.files)).await?))
}
async fn validate(State(s): Service, Json(p): Json<Package>) -> Reply {
    Ok(Json(s.validate(p.id, json!(p.files)).await?))
}
async fn update(State(s): Service, Path(id): Path<String>, Json(p): Json<Update>) -> Reply {
    Ok(Json(
        s.update(id, json!(p.files), p.expected_revision).await?,
    ))
}
async fn delete(State(s): Service, Path(id): Path<String>) -> Reply {
    Ok(Json(s.delete(id).await?))
}
async fn start(State(s): Service, Path(id): Path<String>, Json(p): Json<Start>) -> Reply {
    Ok(Json(
        s.start(
            id,
            p.run_id,
            &p.workspace,
            Value::Object(p.variables),
            p.executor_ref,
        )
        .await?,
    ))
}
async fn runs(State(s): Service) -> Reply {
    Ok(Json(s.runs().await?))
}
async fn run(State(s): Service, Path(id): Path<String>) -> Reply {
    Ok(Json(s.run(id).await?))
}
async fn history(State(s): Service, Path(id): Path<String>) -> Reply {
    Ok(Json(s.history(id).await?))
}
async fn stop(State(s): Service, Path(id): Path<String>) -> Reply {
    Ok(Json(s.stop(id).await?))
}
async fn config(State(s): Service) -> Reply {
    Ok(Json(s.config().await?))
}
async fn configure(State(s): Service, Json(patch): Json<Map<String, Value>>) -> Reply {
    Ok(Json(s.configure(Value::Object(patch)).await?))
}
