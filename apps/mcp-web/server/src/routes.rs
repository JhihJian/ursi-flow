use super::*;
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{delete, get, post, put},
};

impl IntoResponse for Error {
    fn into_response(self) -> Response {
        let (code, message) = match self {
            Self::Invalid(s) => (StatusCode::BAD_REQUEST, s),
            Self::NotFound(s) => (StatusCode::NOT_FOUND, s),
            Self::Unavailable(s) => (StatusCode::SERVICE_UNAVAILABLE, s),
            Self::Internal(_) => (StatusCode::INTERNAL_SERVER_ERROR, "工作存储不可用".into()),
        };
        (code, Json(json!({"error":message}))).into_response()
    }
}
pub(super) fn router(platform: McpPlatform) -> Router {
    Router::new()
        .route("/mcp-recognition-rules", get(recognition_rules).put(replace_recognition_rules))
        .route("/mcp-servers", get(index).post(register))
        .route("/mcp-servers/{id}", delete(remove))
        .route("/mcp-servers/{id}/inspection", get(inspect))
        .route("/mcp-servers/{id}/protocol-check", post(check_protocol))
        .route("/mcp-servers/{id}/resources", get(resources))
        .route("/mcp-servers/{id}/resources/read", post(read_resource))
        .route("/mcp-servers/{id}/settings", put(settings))
        .route("/mcp-servers/{id}/catalog/{kind}", get(catalog))
        .route("/mcp-servers/{id}/tools/call", post(call))
        .route("/mcp-servers/{id}/prompts/get", post(prompt))
        .layer(DefaultBodyLimit::max(128 * 1024))
        .with_state(platform)
}
async fn recognition_rules(State(p): State<McpPlatform>) -> Result<Json<Vec<RecognitionRule>>, Error> {
    p.recognition_rules().map(Json)
}
async fn replace_recognition_rules(
    State(p): State<McpPlatform>,
    Json(rules): Json<Vec<RecognitionRule>>,
) -> Result<Json<Vec<RecognitionRule>>, Error> {
    p.replace_recognition_rules(rules).await.map(Json)
}
async fn index(State(p): State<McpPlatform>) -> Result<Json<Vec<Value>>, Error> {
    p.list().map(|rows| Json(rows.iter().map(ServerRecord::redacted).collect()))
}
async fn register(
    State(p): State<McpPlatform>,
    Json(cfg): Json<Config>,
) -> Result<Json<Value>, Error> {
    p.register(cfg).map(|row| Json(row.redacted()))
}
async fn remove(
    State(p): State<McpPlatform>,
    Path(id): Path<String>,
) -> Result<Json<Value>, Error> {
    p.remove(&id)?;
    Ok(Json(json!({"id":id})))
}
async fn settings(
    State(p): State<McpPlatform>,
    Path(id): Path<String>,
    Json(s): Json<Settings>,
) -> Result<Json<Settings>, Error> {
    p.replace_settings(&id, s).map(Json)
}
async fn resources(
    State(p): State<McpPlatform>,
    Path(id): Path<String>,
) -> Result<Json<Value>, Error> {
    p.list_resources(&id).await.map(Json)
}
async fn inspect(
    State(p): State<McpPlatform>,
    Path(id): Path<String>,
) -> Result<Json<Value>, Error> {
    p.inspect(&id).await.map(Json)
}
async fn check_protocol(
    State(p): State<McpPlatform>,
    Path(id): Path<String>,
) -> Result<Json<ProtocolCheck>, Error> {
    p.check_protocol(&id).await.map(Json)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadRequest {
    uri: String,
}
async fn read_resource(
    State(p): State<McpPlatform>,
    Path(id): Path<String>,
    Json(q): Json<ReadRequest>,
) -> Result<Json<Value>, Error> {
    Ok(Json(json!({"contents":p.preview(&id,&q.uri).await?})))
}
async fn catalog(
    State(p): State<McpPlatform>,
    Path((id, kind)): Path<(String, Catalog)>,
) -> Result<Json<Value>, Error> {
    p.catalog(&id, kind).await.map(Json)
}
async fn call(
    State(p): State<McpPlatform>,
    Path(id): Path<String>,
    Json(q): Json<Input>,
) -> Result<Json<Value>, Error> {
    p.call_tool(&id, q).await.map(Json)
}
async fn prompt(
    State(p): State<McpPlatform>,
    Path(id): Path<String>,
    Json(q): Json<Input>,
) -> Result<Json<Value>, Error> {
    p.get_prompt(&id, q).await.map(Json)
}
