use super::*;
use axum::body::Body;
use reqwest::Method;
use uuid::Uuid;

pub(super) fn routes() -> Router<ApiState> {
    Router::new()
        .route("/api/v1/sandboxes/{id}/observations", post(begin))
        .route("/api/v1/sandboxes/{id}/observations/{run}", get(status))
        .route("/api/v1/sandboxes/{id}/observations/{run}/stop", post(stop))
        .route(
            "/api/v1/sandboxes/{id}/observations/{run}/segments/{number}",
            get(segment),
        )
}

fn client(state: &ApiState) -> Result<&reqwest::Client, ApiError> {
    state
        .observer
        .as_ref()
        .filter(|_| state.service.driver_name() == "docker")
        .ok_or_else(|| Error::Unsupported("observer disabled".into()).into())
}
async fn forward(req: reqwest::RequestBuilder) -> Result<Response, ApiError> {
    let r = req
        .send()
        .await
        .map_err(|_| Error::Unavailable("observer offline".into()))?;
    match r.status().as_u16() {
        200..=202 => {}
        404 => return Err(Error::NotFound("observation".into()).into()),
        409 => return Err(Error::Conflict("observation".into()).into()),
        400 => return Err(ApiError::invalid("Invalid observation request")),
        _ => return Err(Error::Unavailable("observer failed".into()).into()),
    }
    let mut builder = Response::builder().status(r.status());
    for h in [header::CONTENT_TYPE, header::CONTENT_LENGTH] {
        if let Some(v) = r.headers().get(&h) {
            builder = builder.header(h, v);
        }
    }
    Ok(builder
        .body(Body::from_stream(r.bytes_stream()))
        .expect("valid response"))
}
async fn begin(State(s): State<ApiState>, path: IdPath) -> Result<Response, ApiError> {
    let id = sandbox_id(path)?;
    let client = client(&s)?;
    let target = s.service.capture_target(&id).await?;
    forward(client.post(format!("http://localhost/{id}")).json(&target)).await
}
fn record(
    s: &ApiState,
    id: &str,
    run: &str,
    method: Method,
    suffix: &str,
) -> Result<reqwest::RequestBuilder, ApiError> {
    if !valid_name(id) {
        return Err(ApiError::invalid("Invalid sandbox identifier"));
    }
    let run =
        Uuid::parse_str(run).map_err(|_| ApiError::invalid("Invalid observation identifier"))?;
    Ok(client(s)?.request(method, format!("http://localhost/{id}/{run}{suffix}")))
}
type RecordPath = Result<Path<(String, String)>, PathRejection>;
async fn status(State(s): State<ApiState>, path: RecordPath) -> Result<Response, ApiError> {
    let Path((id, run)) = path.map_err(|_| ApiError::invalid("Invalid observation"))?;
    forward(record(&s, &id, &run, Method::GET, "")?).await
}
async fn stop(State(s): State<ApiState>, path: RecordPath) -> Result<Response, ApiError> {
    let Path((id, run)) = path.map_err(|_| ApiError::invalid("Invalid observation"))?;
    forward(record(&s, &id, &run, Method::POST, "/stop")?).await
}
async fn segment(
    State(s): State<ApiState>,
    path: Result<Path<(String, String, u64)>, PathRejection>,
) -> Result<Response, ApiError> {
    let Path((id, run, n)) = path.map_err(|_| ApiError::invalid("Invalid segment"))?;
    forward(record(
        &s,
        &id,
        &run,
        Method::GET,
        &format!("/segments/{n}"),
    )?)
    .await
}
