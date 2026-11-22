//! Authorization boundary for the platform HTTP application.
use crate::work::{Error, Store, catalog};
use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::{FromRequestParts, MatchedPath, RawPathParams, Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
};
use serde_json::{Map, Value, json};
use std::{collections::HashSet, io, sync::Arc};
use tower::ServiceExt;
use uuid::Uuid;

#[cfg(test)]
mod tests;

#[derive(Clone)]
pub struct Tokens(Arc<[String; 3]>);

impl Tokens {
    pub fn new(admin: String, workbench: String, runtime: String) -> io::Result<Self> {
        let keys = [admin, workbench, runtime];
        if keys.iter().enumerate().any(|(i, k)| {
            k.is_empty() || !k.bytes().all(|b| b.is_ascii_graphic()) || keys[..i].contains(k)
        }) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "平台令牌必须不同，且只含非空可见 ASCII 字符",
            ));
        }
        Ok(Self(Arc::new(keys)))
    }

    fn owner(&self, headers: &HeaderMap) -> Option<&'static str> {
        let mut values = headers.get_all(header::AUTHORIZATION).iter();
        let token = values.next()?.as_bytes().strip_prefix(b"Bearer ")?;
        if values.next().is_some() {
            return None;
        }
        self.0
            .iter()
            .zip([ADMIN, "workbench", "runtime"])
            .find_map(|(key, role)| (key.as_bytes() == token).then_some(role))
    }
}

const ADMIN: &str = "admin";
const OWNERS: &str = "executorAttemptOwners";
const ATTEMPTS: &str = "executorAttempts";
const START_LIMIT: usize = 128 * 1024 * 1024;

pub fn secured(api: Router, store: Store, tokens: Tokens) -> Router {
    let picker = Router::new().nest("/api", catalog::consumer_routes(store.clone()));
    Router::new()
        .nest("/api", api)
        .layer(middleware::from_fn_with_state(
            (store, tokens, picker),
            guard,
        ))
}

fn corrupt() -> Error {
    Error::Internal("平台记录损坏".into())
}
fn hidden() -> Error {
    Error::NotFound("资源不存在".into())
}
fn invalid() -> Error {
    Error::Invalid("无效的执行请求".into())
}
fn table<'a>(db: &'a Value, key: &str) -> Result<Option<&'a Map<String, Value>>, Error> {
    db.get(key)
        .map(|v| v.as_object().ok_or_else(corrupt))
        .transpose()
}
fn name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s != "."
        && s != ".."
        && s.chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.'))
}
fn uuid(s: &str) -> bool {
    Uuid::parse_str(s).is_ok_and(|u| u.to_string() == s)
}

async fn guard(
    State((store, tokens, picker)): State<(Store, Tokens, Router)>,
    mut req: Request,
    next: Next,
) -> Response {
    let Some(owner) = tokens.owner(req.headers()) else {
        return (
            StatusCode::UNAUTHORIZED,
            [(header::WWW_AUTHENTICATE, "Bearer")],
        )
            .into_response();
    };
    req.headers_mut().remove(header::AUTHORIZATION);
    let mut response = match authorize(&store, picker, owner, req, next).await {
        Ok(r) => r,
        Err(e) => e.into_response(),
    };
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    response
}

async fn authorize(
    store: &Store,
    picker: Router,
    owner: &'static str,
    req: Request,
    next: Next,
) -> Result<Response, Error> {
    // Use the dispatcher's template and its once-decoded captures, not a separately
    // decoded/split request URI. Reject separators and dot segments inside captures.
    let (mut parts, body) = req.into_parts();
    let path = parts
        .extensions
        .get::<MatchedPath>()
        .and_then(|p| p.as_str().strip_prefix("/api/v2/"))
        .ok_or_else(hidden)?
        .to_owned();
    let params = RawPathParams::from_request_parts(&mut parts, &())
        .await
        .map_err(|_| invalid())?;
    if params.iter().any(|(_, s)| !name(s)) {
        return Err(invalid());
    }
    let param = |key| params.iter().find(|(k, _)| *k == key).map(|(_, v)| v);
    let id = param("id").unwrap_or("");
    let method = parts.method.clone();
    let req = Request::from_parts(parts, body);
    let admin = owner == ADMIN;
    match (method.as_str(), path.as_str()) {
        ("GET", "node-executors/{id}/{revision}") => (),
        (
            "GET",
            "executors"
            | "executors/{id}"
            | "executors/{id}/revisions"
            | "executors/{id}/revisions/{revision}",
        ) => {
            if !admin {
                // Dispatch a fresh GET. Do not carry admin captures or request extensions
                // into the consumer router, which exposes only catalog projections.
                let mut public = Request::new(Body::empty());
                *public.uri_mut() = req.uri().clone();
                return Ok(picker
                    .oneshot(public)
                    .await
                    .unwrap_or_else(|never| match never {}));
            }
        }
        ("PUT", "executor-attempts/{id}") if uuid(id) => {
            return start(store, owner, id, req, next).await;
        }
        ("GET", "executor-attempts/{id}") | ("POST", "executor-attempts/{id}/cancel")
            if uuid(id) =>
        {
            store.read(|db| check_owner(db, id, owner))?;
        }
        ("GET", "directories") if admin => {
            return store.read(directory_index).map(|v| Json(v).into_response());
        }
        ("POST", "directories") if admin => (),
        ("GET", "patches/config/{id}") if owner == "workbench" && uuid(id) => {
            // A business package can reference a known platform ID. Do not expose
            // names, directory handles, file contents or the config collection.
            return store.read(|db| {
                let row = table(db, "configPatches")?
                    .and_then(|rows| rows.get(id))
                    .ok_or_else(hidden)?;
                if row["id"] != id {
                    return Err(corrupt());
                }
                Ok(Json(json!({"id":id})).into_response())
            });
        }
        ("GET", "directories/{id}" | "directories/{id}/tree" | "directories/{id}/file")
        | ("PUT", "directories/{id}/file")
        | ("POST", "directories/{id}/dir" | "directories/{id}/move")
        | ("DELETE", "directories/{id}/entry")
            if uuid(id) =>
        {
            store.read(|db| directory_access(db, id, owner, method == Method::GET))?;
        }
        (
            "GET",
            "resources"
            | "resources/{id}"
            | "resources/{id}/revisions"
            | "resources/{id}/revisions/{revision}"
            | "agent-options"
            | "agent-backends"
            | "patches/config"
            | "patches/config/{id}",
        )
        | (
            "POST",
            "resources"
            | "executors"
            | "resources/{id}/deactivate"
            | "executors/{id}/deactivate"
            | "agent-backends/{id}/check"
            | "patches/config",
        ) if admin => (),
        _ => return Ok(StatusCode::FORBIDDEN.into_response()),
    }
    Ok(next.run(req).await)
}

fn check_owner(db: &Value, id: &str, owner: &str) -> Result<(), Error> {
    if table(db, OWNERS)?
        .and_then(|m| m.get(id))
        .and_then(Value::as_str)
        == Some(owner)
    {
        Ok(())
    } else {
        Err(hidden())
    }
}

async fn start(
    store: &Store,
    owner: &'static str,
    id: &str,
    req: Request,
    next: Next,
) -> Result<Response, Error> {
    let (parts, body) = req.into_parts();
    if !parts
        .headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(';').next())
        .is_some_and(|v| v.trim().eq_ignore_ascii_case("application/json"))
    {
        return Ok(StatusCode::UNSUPPORTED_MEDIA_TYPE.into_response());
    }
    let Ok(bytes) = to_bytes(body, START_LIMIT).await else {
        return Ok(StatusCode::PAYLOAD_TOO_LARGE.into_response());
    };
    let v: Value = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    let fields = v.as_object().ok_or_else(invalid)?;
    if fields.keys().any(|k| {
        !matches!(
            k.as_str(),
            "executorRef" | "previewDefinition" | "workInstruction" | "runConfig" | "inputs"
        )
    }) || v["workInstruction"]["encoding"] != "utf-8"
        || !v["workInstruction"]["text"]
            .as_str()
            .is_some_and(|s| !s.trim().is_empty() && s.len() <= 256 * 1024)
        || !v["workInstruction"]
            .as_object()
            .is_some_and(|o| o.len() == 2)
        || fields.get("runConfig").is_some_and(|v| !v.is_object())
        || fields.get("inputs").is_some_and(|v| !v.is_array())
    {
        return Err(invalid());
    }
    match (fields.get("executorRef"), fields.get("previewDefinition")) {
        (Some(r), None) => {
            // Existing attempts replay their frozen binding, even after deactivation.
            let replay = store.read(|db| {
                Ok(table(db, ATTEMPTS)?
                    .and_then(|m| m.get(id))
                    .is_some_and(|row| {
                        row["request"]["executorRef"] == *r && db[OWNERS][id] == owner
                    }))
            })?;
            if !replay {
                catalog::resolve_consumer_ref(store, r)?;
            }
        }
        (None, Some(p)) if owner == ADMIN && p.is_object() => (),
        (_, Some(_)) if owner != ADMIN => return Ok(StatusCode::FORBIDDEN.into_response()),
        _ => return Err(invalid()),
    };
    // Reservation and legacy-row exclusion are one durable compare-and-set. Never
    // release an ID on backend error: execution can outlive the HTTP connection.
    store.update(|db| {
        if table(db, OWNERS)?.is_some_and(|m| m.contains_key(id)) {
            return check_owner(db, id, owner);
        }
        if table(db, ATTEMPTS)?.is_some_and(|m| m.contains_key(id)) {
            return Err(hidden());
        }
        db[OWNERS][id] = json!(owner);
        Ok(())
    })?;
    drop(v);
    Ok(next
        .run(Request::from_parts(parts, Body::from(bytes)))
        .await)
}

fn directory_access(db: &Value, id: &str, owner: &str, read: bool) -> Result<(), Error> {
    let rec = &db["directories"][id];
    if rec["id"] != id {
        return Err(hidden());
    }
    let mut artifact = false;
    for (attempt, row) in table(db, ATTEMPTS)?.into_iter().flatten() {
        let result = &row["result"];
        if result["artifactDirectoryId"] != id {
            continue;
        }
        if artifact
            || !read
            || rec["state"] != "frozen"
            || result["attemptId"] != *attempt
            || !matches!(
                result["status"].as_str(),
                Some("succeeded" | "failed" | "cancelled")
            )
        {
            return Err(hidden());
        }
        check_owner(db, attempt, owner)?;
        artifact = true;
    }
    if artifact || (owner == ADMIN && writable(rec)) {
        Ok(())
    } else {
        Err(hidden())
    }
}

fn writable(rec: &Value) -> bool {
    rec.get("state").is_none() || rec["state"] == "writable"
}

fn directory_index(db: &Value) -> Result<Value, Error> {
    let artifacts: HashSet<_> = table(db, ATTEMPTS)?
        .into_iter()
        .flatten()
        .filter_map(|(_, row)| row["result"]["artifactDirectoryId"].as_str())
        .collect();
    Ok(Value::Array(
        table(db, "directories")?
            .into_iter()
            .flatten()
            .filter(|(id, rec)| {
                rec["id"] == id.as_str() && writable(rec) && !artifacts.contains(id.as_str())
            })
            .map(|(id, _)| json!({"id":id}))
            .collect(),
    ))
}
