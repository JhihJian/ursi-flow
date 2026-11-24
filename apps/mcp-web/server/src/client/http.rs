//! HTTP body budgets and endpoint policy for the SDK's Streamable HTTP transport.
use super::{Error, SNAPSHOT_LIMIT, rpc_err};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use futures_util::{StreamExt, TryStreamExt, stream::BoxStream};
use reqwest::{
    Client, Method, RequestBuilder, Url,
    header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, HeaderName, HeaderValue},
    redirect::Policy,
};
use rmcp::{
    model::{ClientJsonRpcMessage, ClientRequest, JsonRpcMessage},
    transport::streamable_http_client::{
        SseError, StreamableHttpClient, StreamableHttpError, StreamableHttpPostResponse,
    },
};
use serde_json::Value;
use sse_stream::{Sse, SseStream};
use std::{
    collections::HashMap,
    io,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

type Headers = HashMap<HeaderName, HeaderValue>;
type HttpError = StreamableHttpError<io::Error>;
type SseEvents = BoxStream<'static, Result<Sse, SseError>>;
const SESSION_ID: &str = "mcp-session-id";

fn bad_response() -> HttpError {
    HttpError::Client(io::Error::other(
        "MCP HTTP request failed or response was invalid",
    ))
}

/// SEP-2243 要求 `tools/call` 为参数补发 `Mcp-Param-*` 头，但 SDK 只为
/// schema 里显式标注 `x-mcp-header` 的参数发头；GitHub 等远端则按
/// required 参数强制校验。这里对全部顶层基本类型参数补齐头，多余的头
/// 不会被远端校验拒绝。
fn standard_param_headers(message: &ClientJsonRpcMessage, mut headers: Headers) -> Headers {
    let ClientJsonRpcMessage::Request(request) = message else {
        return headers;
    };
    let ClientRequest::CallToolRequest(call) = &request.request else {
        return headers;
    };
    let Some(arguments) = call.params.arguments.as_ref() else {
        return headers;
    };
    for (key, value) in arguments {
        let mut owned = String::new();
        let text = match value {
            Value::String(text) => text.as_str(),
            Value::Bool(true) => "true",
            Value::Bool(false) => "false",
            Value::Number(number) => {
                owned = number.to_string();
                if !owned.chars().all(|c| c.is_ascii()) {
                    continue;
                }
                owned.as_str()
            }
            _ => continue,
        };
        let name = match HeaderName::from_bytes(
            format!("mcp-param-{}", key.to_ascii_lowercase()).as_bytes(),
        ) {
            Ok(name) => name,
            Err(_) => continue,
        };
        if headers.contains_key(&name) {
            continue;
        }
        if let Ok(value) = HeaderValue::from_str(&encode_header_value(text)) {
            headers.insert(name, value);
        }
    }
    headers
}

/// 与 SDK 一致：非可见 ASCII 的值用 `=?base64?..?=` 包装。
fn encode_header_value(value: &str) -> String {
    let needs_encoding = !value.is_empty()
        && (value.starts_with([' ', '\t'])
            || value.ends_with([' ', '\t'])
            || value.chars().any(|c| (c as u32) < 0x20 || (c as u32) > 0x7E));
    if needs_encoding {
        format!("=?base64?{}?=", BASE64_STANDARD.encode(value.as_bytes()))
    } else {
        value.to_owned()
    }
}

// The SDK's untagged resource model accepts a text part even when `blob` is present.
// Reject this ambiguity at the wire boundary, before typed decoding can discard the other field.
fn validate_result(value: &Value, is_read: bool) -> io::Result<()> {
    if let Some(result) = value.get("result") {
        let ambiguous = is_read
            && result["contents"].as_array().is_some_and(|parts| {
                parts
                    .iter()
                    .any(|part| part.get("text").is_some() && part.get("blob").is_some())
            });
        if !result.is_object()
            || value.get("error").is_some()
            || value.get("method").is_some()
            || ambiguous
        {
            return Err(io::Error::other("invalid MCP result"));
        }
    }
    Ok(())
}

// Only locally authored text and numeric status/error codes enter this slot.
#[derive(Clone, Default)]
pub(super) struct Diagnostic(Arc<std::sync::Mutex<Option<String>>>);
impl Diagnostic {
    fn note(&self, text: String) {
        *self.0.lock().unwrap() = Some(text);
    }
    pub(super) fn error(&self, context: &str) -> Error {
        let note = self.0.lock().unwrap();
        super::unavailable(&format!(
            "{context}：{}",
            note.as_deref().unwrap_or("协议响应无效或版本不匹配")
        ))
    }
}
#[derive(Clone)]
pub(super) struct BoundedHttp {
    pub(super) diagnostic: Diagnostic,
    pub(super) discovery: Arc<std::sync::OnceLock<Value>>,
    pub(super) used_initialize: Arc<AtomicBool>,
    client: Client,
    endpoint: Url,
    authorization: Option<HeaderValue>,
}

impl BoundedHttp {
    pub(super) fn new(
        endpoint: Url,
        authorization: Option<HeaderValue>,
        settings: &super::super::operations::Settings,
    ) -> Result<Self, Error> {
        let headers = settings.headers(&endpoint)?;
        let client = Client::builder()
            .default_headers(headers)
            .no_proxy()
            .redirect(Policy::none())
            .connect_timeout(Duration::from_secs(3))
            // No client-wide timeout: tool catalogs can stream for tens of
            // seconds. POSTs below carry their own total-time budget.
            .retry(reqwest::retry::never())
            .build()
            .map_err(|_| rpc_err())?;
        Ok(Self {
            discovery: Default::default(),
            used_initialize: Default::default(),
            diagnostic: Default::default(),
            client,
            endpoint,
            authorization,
        })
    }

    fn request(&self, method: Method, headers: Headers, session: Option<&str>) -> RequestBuilder {
        let mut req = self.client.request(method, self.endpoint.clone());
        for (key, value) in headers {
            req = req.header(key, value);
        }
        if let Some(value) = &self.authorization {
            req = req.header(AUTHORIZATION, value.clone());
        }
        if let Some(id) = session {
            req = req.header(SESSION_ID, id);
        }
        req
    }
}

impl StreamableHttpClient for BoundedHttp {
    type Error = io::Error;

    async fn post_message(
        &self,
        uri: Arc<str>,
        message: ClientJsonRpcMessage,
        session: Option<Arc<str>>,
        auth: Option<String>,
        headers: Headers,
    ) -> Result<StreamableHttpPostResponse, HttpError> {
        self.post_message_with_max_sse_event_size(
            uri,
            message,
            session,
            auth,
            headers,
            SNAPSHOT_LIMIT,
        )
        .await
    }

    async fn post_message_with_max_sse_event_size(
        &self,
        _: Arc<str>,
        message: ClientJsonRpcMessage,
        session: Option<Arc<str>>,
        _: Option<String>,
        headers: Headers,
        budget: usize,
    ) -> Result<StreamableHttpPostResponse, HttpError> {
        let headers = standard_param_headers(&message, headers);
        let is_read = matches!(&message, JsonRpcMessage::Request(request) if matches!(request.request, ClientRequest::ReadResourceRequest(_)));
        let stage = match &message {
            JsonRpcMessage::Request(r) => match &r.request {
                ClientRequest::DiscoverRequest(_) => "server/discover",
                ClientRequest::InitializeRequest(_) => {
                    self.used_initialize.store(true, Ordering::Relaxed);
                    "initialize"
                }
                ClientRequest::ListToolsRequest(_) => "tools/list",
                ClientRequest::ListPromptsRequest(_) => "prompts/list",
                ClientRequest::ListResourceTemplatesRequest(_) => "resources/templates/list",
                _ => "MCP 请求",
            },
            _ => "MCP 通知",
        };
        let diag = &self.diagnostic;
        diag.note(format!("{stage} 未取得有效的协议响应"));
        let response = self
            .request(Method::POST, headers, session.as_deref())
            .header(ACCEPT, "application/json, text/event-stream")
            .json(&message)
            // Total budget including body streaming: catalog pages take
            // several seconds on large servers but must never hang forever.
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(|e| {
                diag.note(format!(
                    "{stage} {}",
                    if e.is_timeout() {
                        "请求超时"
                    } else {
                        "网络连接失败"
                    }
                ));
                bad_response()
            })?;
        let discover_id = match &message {
            JsonRpcMessage::Request(r)
                if matches!(r.request, ClientRequest::DiscoverRequest(_)) =>
            {
                Some(r.id.clone())
            }
            _ => None,
        };
        let status = response.status();
        let legacy_rejection = discover_id.is_some()
            && session.is_none()
            && matches!(status.as_u16(), 400 | 404 | 405);
        diag.note(format!(
            "{stage} 收到远端 HTTP {}，未完成协议处理",
            status.as_u16()
        ));
        if !status.is_success() && !legacy_rejection {
            return Err(bad_response());
        }
        if matches!(status.as_u16(), 202 | 204) {
            return Ok(StreamableHttpPostResponse::Accepted);
        }
        let id = response
            .headers()
            .get(SESSION_ID)
            .map(|value| {
                let id = value.to_str().map_err(|_| bad_response())?;
                if id.is_empty() || id.len() > 512 || !id.bytes().all(|b| b.is_ascii_graphic()) {
                    return Err(bad_response());
                }
                Ok(id.to_owned())
            })
            .transpose()?;
        let media = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(';').next())
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase();
        let mut remaining = budget.min(SNAPSHOT_LIMIT);
        let body_diag = diag.clone();
        let mut body = response
            .bytes_stream()
            .map_err(|_| io::Error::other("invalid MCP response body"))
            .and_then(move |chunk| {
                std::future::ready(match remaining.checked_sub(chunk.len()) {
                    Some(left) => {
                        remaining = left;
                        Ok(chunk)
                    }
                    None => {
                        body_diag.note(format!("{stage} 的响应超过大小上限"));
                        Err(io::Error::other("MCP response exceeds body budget"))
                    }
                })
            });
        if legacy_rejection {
            let mut bytes = Vec::new();
            while let Some(chunk) = body.try_next().await.map_err(|_| bad_response())? {
                bytes.extend_from_slice(&chunk);
            }
            let error = serde_json::from_slice::<Value>(&bytes)
                .ok()
                .and_then(|v| serde_json::from_value(v["error"].clone()).ok())
                .unwrap_or_else(|| {
                    rmcp::model::ErrorData::invalid_request("Discovery rejected", None)
                });
            return Ok(StreamableHttpPostResponse::Json(
                JsonRpcMessage::error(error, discover_id),
                None,
            ));
        }
        // The SDK retains the selected version but discards the advertised version list.
        let snapshot = self.discovery.clone();
        let wire_diag = diag.clone();
        let inspect = move |value: &Value| -> io::Result<()> {
            if let Some(code) = value["error"]["code"].as_i64() {
                wire_diag.note(format!("{stage} 返回 JSON-RPC 错误 {code}"));
            }
            validate_result(value, is_read)?;
            if let Some(id) = &discover_id
                && value["id"] == serde_json::json!(id)
                && value["result"]["supportedVersions"].is_array()
            {
                let _ = snapshot.set(serde_json::json!({"supportedVersions":value["result"]["supportedVersions"],"capabilities":value["result"]["capabilities"]}));
            }
            Ok(())
        };
        match media.as_str() {
            "application/json" => {
                let mut bytes = Vec::new();
                while let Some(chunk) = body.try_next().await.map_err(|_| bad_response())? {
                    bytes.extend_from_slice(&chunk);
                }
                let value = serde_json::from_slice(&bytes).map_err(|_| {
                    diag.note(format!("{stage} 的响应不是有效 JSON"));
                    bad_response()
                })?;
                inspect(&value).map_err(HttpError::Client)?;
                Ok(StreamableHttpPostResponse::Json(
                    serde_json::from_value(value).map_err(|_| {
                        diag.note(format!("{stage} 的 JSON 不符合 MCP 响应结构"));
                        bad_response()
                    })?,
                    id,
                ))
            }
            "text/event-stream" => {
                let events = SseStream::from_bytes_stream(body)
                    .map(move |event| {
                        let event = event?;
                        if event.event.as_deref().is_none_or(|kind| kind == "message") {
                            if let Some(value) = event
                                .data
                                .as_deref()
                                .and_then(|text| serde_json::from_str(text).ok())
                            {
                                inspect(&value).map_err(|err| SseError::Body(Box::new(err)))?;
                            }
                        }
                        Ok(event)
                    })
                    .boxed();
                Ok(StreamableHttpPostResponse::Sse(events, id))
            }
            _ => {
                diag.note(format!("{stage} 的响应类型不是 JSON 或 SSE"));
                Err(bad_response())
            }
        }
    }

    async fn delete_session(
        &self,
        _: Arc<str>,
        session: Arc<str>,
        _: Option<String>,
        headers: Headers,
    ) -> Result<(), HttpError> {
        let _ = self
            .request(Method::DELETE, headers, Some(&session))
            .timeout(Duration::from_secs(1))
            .send()
            .await
            .map_err(|_| bad_response())?;
        Ok(())
    }

    async fn get_stream(
        &self,
        _: Arc<str>,
        _: Option<Arc<str>>,
        _: Option<String>,
        _: Option<String>,
        _: Headers,
    ) -> Result<SseEvents, HttpError> {
        // Replies arrive on the initiating POST. No idle subscriptions or resume.
        Err(StreamableHttpError::ServerDoesNotSupportSse)
    }
}
