//! Agent 会话消费者，通过 ACP WebSocket 交换 JSON-RPC 消息。
use crate::{Error, Result, Secret, checked_url};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::{
    net::TcpStream,
    time::{Instant, timeout_at},
};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream,
    tungstenite::{Message, client::IntoClientRequest},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptOutcome {
    Completed,
    Cancelled,
}
impl PromptOutcome {
    pub fn from_result(result: &Value) -> Result<Self> {
        match result["stopReason"].as_str() {
            Some("end_turn") => Ok(Self::Completed),
            Some("cancelled") => Ok(Self::Cancelled),
            _ => Err(Error::Protocol(
                "prompt 缺少已知 stopReason，不能判为成功".into(),
            )),
        }
    }
}

/// 每条连接串行发送请求。通知不完成请求，只有同 ID 的响应能完成请求。
/// 另一个连接可取消/查询同一身份下的会话。断线不重试 prompt。
pub struct Acp {
    socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
    token: Option<Secret>,
    next_id: u64,
    timeout: Duration,
}
impl Acp {
    pub async fn connect(url: &str, token: Secret, timeout: Duration) -> Result<Self> {
        Self::connect_inner(url, Some(token), timeout).await
    }

    /// 连接未要求应用层身份的 ACP 服务。Pi session-service 使用 `connect`。
    pub async fn connect_without_auth(url: &str, timeout: Duration) -> Result<Self> {
        Self::connect_inner(url, None, timeout).await
    }

    async fn connect_inner(url: &str, token: Option<Secret>, timeout: Duration) -> Result<Self> {
        let url = checked_url(url, &["ws", "wss"])?;
        let mut request = url
            .as_str()
            .into_client_request()
            .map_err(|_| Error::Invalid("ACP URL 无效".into()))?;
        if let Some(token) = &token {
            let mut auth = format!("Bearer {}", token.0)
                .parse::<tokio_tungstenite::tungstenite::http::HeaderValue>()
                .map_err(|_| Error::Invalid("session token 无效".into()))?;
            auth.set_sensitive(true);
            request.headers_mut().insert("Authorization", auth);
        }
        let config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default()
            .max_message_size(Some(1024 * 1024))
            .max_frame_size(Some(1024 * 1024));
        let (socket, _) = tokio::time::timeout(
            timeout,
            tokio_tungstenite::connect_async_with_config(request, Some(config), false),
        )
        .await
        .map_err(|_| Error::Timeout)?
        .map_err(|_| Error::Transport)?;
        Ok(Self {
            socket,
            token,
            next_id: 1,
            timeout,
        })
    }
    pub async fn initialize(&mut self) -> Result<Value> {
        let result = self
            .request(
                "initialize",
                json!({"protocolVersion":1,"clientCapabilities":{}}),
                |_| {},
            )
            .await?;
        if result["protocolVersion"] != 1 {
            return Err(Error::Protocol("ACP 协议版本不支持".into()));
        }
        Ok(result)
    }
    pub async fn notify(&mut self, method: &str, params: Value) -> Result<()> {
        tokio::time::timeout(
            self.timeout,
            self.socket.send(Message::Text(
                json!({"jsonrpc":"2.0","method":method,"params":params})
                    .to_string()
                    .into(),
            )),
        )
        .await
        .map_err(|_| Error::Timeout)?
        .map_err(|_| Error::Transport)
    }
    pub async fn request(
        &mut self,
        method: &str,
        params: Value,
        mut on_update: impl FnMut(Value),
    ) -> Result<Value> {
        let id = self.next_id;
        self.next_id = self
            .next_id
            .checked_add(1)
            .ok_or_else(|| Error::Protocol("请求 ID 耗尽".into()))?;
        let deadline = Instant::now() + self.timeout;
        timeout_at(
            deadline,
            self.socket.send(Message::Text(
                json!({"jsonrpc":"2.0","id":id,"method":method,"params":params})
                    .to_string()
                    .into(),
            )),
        )
        .await
        .map_err(|_| Error::Timeout)?
        .map_err(|_| Error::Transport)?;
        loop {
            if Instant::now() >= deadline {
                return Err(Error::Timeout);
            }
            let message = timeout_at(deadline, self.socket.next())
                .await
                .map_err(|_| Error::Timeout)?
                .ok_or(Error::Closed)?
                .map_err(|_| Error::Transport)?;
            let text = match message {
                Message::Text(text) => text,
                Message::Ping(data) => {
                    timeout_at(deadline, self.socket.send(Message::Pong(data)))
                        .await
                        .map_err(|_| Error::Timeout)?
                        .map_err(|_| Error::Transport)?;
                    continue;
                }
                Message::Pong(_) => continue,
                Message::Close(_) => return Err(Error::Closed),
                _ => return Err(Error::Protocol("ACP 需要文本 JSON 消息".into())),
            };
            let value: Value =
                serde_json::from_str(&text).map_err(|_| Error::Protocol("ACP JSON 无效".into()))?;
            if value["jsonrpc"] != "2.0" {
                return Err(Error::Protocol("JSON-RPC 版本无效".into()));
            }
            if value.get("id").is_none() && value["method"] == "session/update" {
                on_update(
                    self.token
                        .as_ref()
                        .map(|token| token.redact_json(&value["params"]))
                        .unwrap_or_else(|| value["params"].clone()),
                );
                continue;
            }
            if value["id"] != json!(id) {
                continue;
            }
            if value.get("result").is_some() == value.get("error").is_some() {
                return Err(Error::Protocol("响应必须只包含 result 或 error".into()));
            }
            if let Some(error) = value.get("error") {
                return Err(Error::Rpc {
                    code: error["code"].as_i64().unwrap_or(-32000),
                    message: self
                        .token
                        .as_ref()
                        .map(|token| {
                            token.redact(error["message"].as_str().unwrap_or("远端执行失败"))
                        })
                        .unwrap_or_else(|| {
                            error["message"].as_str().unwrap_or("远端执行失败").into()
                        }),
                });
            }
            return Ok(self
                .token
                .as_ref()
                .map(|token| token.redact_json(&value["result"]))
                .unwrap_or_else(|| value["result"].clone()));
        }
    }
}
