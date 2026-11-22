//! Workbench 消费者只能选择修订、提交或核实尝试、读取已发布的制品。
mod inputs;
#[cfg(test)]
mod tests;

use super::{Error, Store, directories};
use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, Path, State},
    http::{Method, StatusCode, Uri, header},
    response::{IntoResponse, Response},
    routing::{MethodFilter as M, on},
};
use reqwest::{Client, Url, header::HeaderValue};
use serde_json::{Value, json};
use std::{collections::HashMap, env, io, time::Duration};
use uuid::Uuid;

#[derive(Clone)]
pub(super) struct Platform {
    store: Store,
    origin: Url,
    bearer: HeaderValue,
    http: Client,
}
fn config_error() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        "需要有效的平台 HTTP(S) origin 和访问令牌",
    )
}
fn upstream() -> Error {
    Error::Unavailable("执行平台不可用或返回了无效响应".into())
}
fn invalid() -> Error {
    Error::Invalid("平台请求参数无效".into())
}
fn uuid(s: &str) -> bool {
    Uuid::parse_str(s).is_ok_and(|u| u.to_string() == s)
}

impl Platform {
    pub(super) fn configured(store: Store) -> io::Result<Self> {
        let origin = env::var("URSI_EXECUTOR_PLATFORM_URL").map_err(|_| config_error())?;
        let token = env::var("URSI_EXECUTOR_PLATFORM_TOKEN").map_err(|_| config_error())?;
        Self::new(store, &origin, &token)
    }
    fn new(store: Store, origin: &str, token: &str) -> io::Result<Self> {
        // URL parsers normalize dot segments and backslashes. Validate the literal origin first.
        let raw = origin
            .strip_prefix("https://")
            .or_else(|| origin.strip_prefix("http://"))
            .ok_or_else(config_error)?;
        let authority = raw.strip_suffix('/').unwrap_or(raw);
        if authority.is_empty()
            || authority.contains(['/', '\\', '?', '#', '@'])
            || origin.chars().any(|c| c.is_whitespace() || c.is_control())
        {
            return Err(config_error());
        }
        let origin = Url::parse(origin).map_err(|_| config_error())?;
        if origin.host().is_none()
            || token.is_empty()
            || !token.bytes().all(|c| c.is_ascii_graphic())
        {
            return Err(config_error());
        }
        let mut bearer =
            HeaderValue::from_str(&format!("Bearer {token}")).map_err(|_| config_error())?;
        bearer.set_sensitive(true);
        let http = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(60))
            .build()
            .map_err(|_| config_error())?;
        Ok(Self {
            store,
            origin,
            bearer,
            http,
        })
    }
    // ID is immutable on the platform. Never fall back to a legacy business-store row.
    pub(super) async fn check_config(&self, id: &str) -> Result<(), Error> {
        if !uuid(id) {
            return Err(invalid());
        }
        let (status, bytes) = self
            .send(
                Method::GET,
                &["patches", "config", id],
                None,
                Bytes::new(),
                8192,
            )
            .await?;
        if status == StatusCode::NOT_FOUND {
            return Err(Error::NotFound("配置包不存在".into()));
        }
        if status != StatusCode::OK || parse(&bytes)?["id"] != id {
            return Err(upstream());
        }
        Ok(())
    }
    async fn send(
        &self,
        method: Method,
        path: &[&str],
        query: Option<&str>,
        body: Bytes,
        limit: usize,
    ) -> Result<(StatusCode, Bytes), Error> {
        let mut url = self.origin.clone();
        url.path_segments_mut()
            .expect("validated origin")
            .clear()
            .extend(["api", "v2"])
            .extend(path.iter().copied());
        url.set_query(query);
        let mut req = self
            .http
            .request(method, url)
            .header(header::AUTHORIZATION, self.bearer.clone());
        if !body.is_empty() {
            req = req
                .header(header::CONTENT_TYPE, "application/json")
                .body(body);
        }
        let mut res = req.send().await.map_err(|_| upstream())?;
        let status = res.status();
        if status != StatusCode::OK {
            // No error body, redirect, auth challenge or cookie crosses this boundary.
            return if status.is_client_error()
                && !matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN)
            {
                Ok((status, Bytes::new()))
            } else {
                Err(upstream())
            };
        }
        let mut data = Vec::new();
        while let Some(chunk) = res.chunk().await.map_err(|_| upstream())? {
            if chunk.len() > limit - data.len() {
                return Err(upstream());
            }
            data.extend_from_slice(&chunk);
        }
        Ok((status, data.into()))
    }
}
fn parse(bytes: &[u8]) -> Result<Value, Error> {
    serde_json::from_slice(bytes).map_err(|_| upstream())
}

pub(super) fn routes(store: Store) -> io::Result<Router> {
    Ok(router(Platform::configured(store)?))
}

fn router(platform: Platform) -> Router {
    let mut r = Router::new();
    for (path, methods) in [
        ("executors", M::GET),
        ("executors/{id}", M::GET),
        ("executors/{id}/revisions", M::GET),
        ("executors/{id}/revisions/{revision}", M::GET),
        ("executor-attempts/{id}", M::GET.or(M::PUT)),
        ("executor-attempts/{id}/cancel", M::POST),
        ("directories/platform-artifact-{id}", M::GET),
        ("directories/platform-artifact-{id}/tree", M::GET),
        ("directories/platform-artifact-{id}/file", M::GET),
    ] {
        r = r.route(
            &format!("/v2/{path}"),
            on(
                methods,
                move |State(s): State<Platform>,
                      Path(params): Path<HashMap<String, String>>,
                      method: Method,
                      uri: Uri,
                      body: Bytes| async move {
                    forward(&s, path, params, method, uri, body).await
                },
            ),
        );
    }
    r.layer(DefaultBodyLimit::max(512 * 1024))
        .with_state(platform)
}

async fn forward(
    p: &Platform,
    template: &str,
    params: HashMap<String, String>,
    method: Method,
    uri: Uri,
    mut body: Bytes,
) -> Result<Response, Error> {
    let id = params.get("id").map(String::as_str).unwrap_or("");
    for s in params.values() {
        if s.is_empty()
            || s.len() > 128
            || matches!(s.as_str(), "." | "..")
            || !s
                .chars()
                .all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.'))
        {
            return Err(invalid());
        }
    }
    let attempt = template.starts_with("executor-attempts/");
    let dir = template.starts_with("directories/");
    let file = dir && template.ends_with("/file");
    if (attempt || dir) && !uuid(id) {
        return Err(invalid());
    }
    if file {
        if !uri
            .query()
            .is_some_and(|q| q.starts_with("path=") && !q.contains('&'))
        {
            return Err(invalid());
        }
    } else if uri.query().is_some() {
        return Err(invalid());
    }
    if method == Method::HEAD || (method != Method::PUT && !body.is_empty()) {
        return Err(invalid());
    }
    let remote_id = if dir {
        let (status, bytes) = p
            .send(
                Method::GET,
                &["executor-attempts", id],
                None,
                Bytes::new(),
                8192,
            )
            .await?;
        if !status.is_success() {
            return Ok(rejected(status));
        }
        let row = parse(&bytes)?;
        let view = attempt_view(&row, id)?;
        if view.get("artifactDirectoryId").is_none() {
            return Err(Error::NotFound("制品尚未发布".into()));
        }
        Some(
            row["artifactDirectoryId"]
                .as_str()
                .ok_or_else(upstream)?
                .to_owned(),
        )
    } else {
        None
    };
    let path = template
        .split('/')
        .map(|seg| match seg {
            "{id}" => id,
            "{revision}" => params.get("revision").map(String::as_str).unwrap_or(""),
            "platform-artifact-{id}" => remote_id.as_deref().expect("resolved directory"),
            literal => literal,
        })
        .collect::<Vec<_>>();
    if attempt && method == Method::PUT {
        let mut request: Value = serde_json::from_slice(&body).map_err(|_| invalid())?;
        let fields = request.as_object_mut().ok_or_else(invalid)?;
        if fields.keys().any(|key| {
            !matches!(
                key.as_str(),
                "workPatchId" | "executorRef" | "runConfig" | "workInstruction"
            )
        }) || !fields.contains_key("executorRef")
        {
            return Err(invalid());
        }
        if let Some(patch) = fields.remove("workPatchId").filter(|p| !p.is_null()) {
            let patch = patch.as_str().ok_or_else(invalid)?.to_owned();
            let store = p.store.clone();
            let key = id.to_owned();
            let origin = p.origin.to_string();
            let snapshot = tokio::task::spawn_blocking(move || {
                inputs::snapshot(&store, &origin, &key, &patch)
            })
            .await
            .map_err(|_| upstream())??;
            fields.insert("inputs".into(), snapshot);
        }
        body = serde_json::to_vec(&request).map_err(|_| invalid())?.into();
    }
    let limit = if file {
        directories::fs::FILE_LIMIT as usize
    } else {
        16 * 1024 * 1024
    };
    let (status, bytes) = p.send(method, &path, uri.query(), body, limit).await?;
    if !status.is_success() {
        return Ok(rejected(status));
    }
    let response = if file {
        (
            [
                (header::CONTENT_TYPE, "application/octet-stream"),
                (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            ],
            bytes,
        )
            .into_response()
    } else {
        let mut value = parse(&bytes)?;
        if attempt {
            value = attempt_view(&value, id)?;
        }
        if dir && path.len() == 2 {
            if value["id"].as_str() != remote_id.as_deref() {
                return Err(upstream());
            }
            value = json!({"id":format!("platform-artifact-{id}")});
        }
        Json(value).into_response()
    };
    Ok(([(header::CACHE_CONTROL, "private, no-store")], response).into_response())
}
fn rejected(status: StatusCode) -> Response {
    (status, Json(json!({"error":"执行平台拒绝请求"}))).into_response()
}

fn attempt_view(row: &Value, id: &str) -> Result<Value, Error> {
    if row["attemptId"] != id || row["artifactDirectoryRef"] != format!("artifacts:{id}") {
        return Err(upstream());
    }
    let terminal = match row["status"].as_str() {
        Some("succeeded" | "failed" | "cancelled") => true,
        Some("running" | "starting" | "unverified") => false,
        _ => return Err(upstream()),
    };
    let mut view = json!({"attemptId":id, "status":row["status"], "artifactDirectoryRef":row["artifactDirectoryRef"]});
    for key in ["backendId", "backendRunRef"] {
        if let Some(v) = row.get(key) {
            if !v.as_str().is_some_and(|s| {
                !s.is_empty() && s.len() <= 256 && !s.chars().any(char::is_control)
            }) {
                return Err(upstream());
            }
            view[key] = v.clone();
        }
    }
    if terminal {
        if !row["artifactDirectoryId"].as_str().is_some_and(uuid) {
            return Err(upstream());
        }
        view["artifactDirectoryId"] = json!(format!("platform-artifact-{id}"));
    } else if !row["artifactDirectoryId"].is_null() {
        return Err(upstream());
    }
    Ok(view)
}
