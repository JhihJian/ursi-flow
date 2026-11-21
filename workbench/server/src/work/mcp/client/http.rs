//! HTTP body budgets and endpoint policy for the SDK's Streamable HTTP transport.
use super::{Error, SNAPSHOT_LIMIT, rpc_err};
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
use std::{collections::HashMap, io, sync::Arc, time::Duration};

type Headers = HashMap<HeaderName, HeaderValue>;
type HttpError = StreamableHttpError<io::Error>;
type SseEvents = BoxStream<'static, Result<Sse, SseError>>;
const SESSION_ID: &str = "mcp-session-id";

fn bad_response() -> HttpError {
    HttpError::Client(io::Error::other(
        "MCP HTTP request failed or response was invalid",
    ))
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

#[derive(Clone)]
pub(super) struct BoundedHttp {
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
            .timeout(Duration::from_secs(8))
            .retry(reqwest::retry::never())
            .build()
            .map_err(|_| rpc_err())?;
        Ok(Self {
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
        let is_read = matches!(&message, JsonRpcMessage::Request(request) if matches!(request.request, ClientRequest::ReadResourceRequest(_)));
        let response = self
            .request(Method::POST, headers, session.as_deref())
            .header(ACCEPT, "application/json, text/event-stream")
            .json(&message)
            .send()
            .await
            .map_err(|_| bad_response())?;
        let status = response.status();
        if !status.is_success() {
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
        let mut body = response
            .bytes_stream()
            .map_err(|_| io::Error::other("invalid MCP response body"))
            .and_then(move |chunk| {
                std::future::ready(match remaining.checked_sub(chunk.len()) {
                    Some(left) => {
                        remaining = left;
                        Ok(chunk)
                    }
                    None => Err(io::Error::other("MCP response exceeds body budget")),
                })
            });
        match media.as_str() {
            "application/json" => {
                let mut bytes = Vec::new();
                while let Some(chunk) = body.try_next().await.map_err(|_| bad_response())? {
                    bytes.extend_from_slice(&chunk);
                }
                let value = serde_json::from_slice(&bytes).map_err(|_| bad_response())?;
                validate_result(&value, is_read).map_err(HttpError::Client)?;
                Ok(StreamableHttpPostResponse::Json(
                    serde_json::from_value(value).map_err(|_| bad_response())?,
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
                                validate_result(&value, is_read)
                                    .map_err(|err| SseError::Body(Box::new(err)))?;
                            }
                        }
                        Ok(event)
                    })
                    .boxed();
                Ok(StreamableHttpPostResponse::Sse(events, id))
            }
            _ => Err(bad_response()),
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
