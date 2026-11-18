//! Runtime ACP v1: one authenticated socket and one session per invocation.
use std::{fs::File, io::Read, net::SocketAddr, path::Path, time::Duration};

use flow_core::{
    agent_runtime::ExecutorError,
    domain::Role,
    sandboxes::{DomainSandboxState, PlatformView, Visibility},
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::{net::TcpStream, sync::watch, time::timeout};
use tokio_tungstenite::{
    WebSocketStream, client_async_with_config,
    tungstenite::{Message, client::IntoClientRequest, protocol::WebSocketConfig},
};

use ursi_sandbox_client::{Acp, PromptOutcome, Secret};

const MAX: usize = 1024 * 1024;
const CONTROL: Duration = Duration::from_secs(15);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Identity {
    sandbox_id: String,
    address: SocketAddr,
    token: String,
    model: String,
}

/// Constructed only after matching the protected identity file to a ready run.
pub struct Binding {
    identity: Identity,
}

fn unavailable() -> ExecutorError {
    ExecutorError::Launch("ACP 绑定缺失或与就绪端点不匹配".into())
}
fn unknown() -> ExecutorError {
    ExecutorError::OutcomeUnknown("未确认 ACP 执行或会话回收结果".into())
}

impl Binding {
    pub async fn resolve(dir: &Path, view: &PlatformView) -> Result<Self, ExecutorError> {
        if !dir.is_absolute()
            || view.state != DomainSandboxState::Ready
            || view.run_id.is_empty()
            || view.run_id.len() > 128
            || !view
                .run_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return Err(unavailable());
        }
        let path = dir.join(format!("{}.json", view.run_id));
        let binding: Identity = tokio::task::spawn_blocking(move || {
            let parent = std::fs::symlink_metadata(path.parent()?).ok()?;
            if !parent.is_dir() || !std::fs::symlink_metadata(&path).ok()?.is_file() {
                return None;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if parent.permissions().mode() & 0o022 != 0 {
                    return None;
                }
            }
            let file = File::open(path).ok()?;
            let meta = file.metadata().ok()?;
            if !meta.is_file() {
                return None;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if meta.permissions().mode() & 0o077 != 0 {
                    return None;
                }
            }
            let mut bytes = Vec::new();
            file.take(8193).read_to_end(&mut bytes).ok()?;
            if bytes.len() > 8192 {
                return None;
            }
            serde_json::from_slice(&bytes).ok()
        })
        .await
        .ok()
        .flatten()
        .ok_or_else(unavailable)?;
        let mut endpoints = view.endpoints.iter().filter(|e| e.name == "session");
        let endpoint = endpoints.next().ok_or_else(unavailable)?;
        let internal = match binding.address.ip() {
            std::net::IpAddr::V4(ip) => ip.is_loopback() || ip.is_private(),
            std::net::IpAddr::V6(ip) => ip.is_loopback() || ip.is_unique_local(),
        };
        if !internal
            || endpoints.next().is_some()
            || endpoint.visibility != Visibility::Internal
            || endpoint.address.parse::<SocketAddr>().ok() != Some(binding.address)
            || view.sandbox_id.as_ref() != Some(&binding.sandbox_id)
            || binding.sandbox_id.is_empty()
            || binding.address.port() == 0
            || binding.model.trim().is_empty()
            || !(32..=4096).contains(&binding.token.len())
            || !binding.token.bytes().all(|b| b.is_ascii_graphic())
        {
            return Err(unavailable());
        }
        Ok(Self { identity: binding })
    }

    /// Read-only observation on a separate SDK connection. A status snapshot is
    /// never a substitute for the prompt's stop reason or a close receipt.
    pub async fn session_status(&self, sid: &str) -> Result<Value, ExecutorError> {
        if sid.is_empty() || sid.len() > 128 {
            return Err(unavailable());
        }
        let mut client = Acp::connect(
            &format!("ws://{}/acp", self.identity.address),
            self.secret()?,
            CONTROL,
        )
        .await
        .map_err(|_| unavailable())?;
        client.initialize().await.map_err(|_| unavailable())?;
        let status = client
            .request("_ursi/session/status", json!({"sessionId": sid}), |_| {})
            .await
            .map_err(|_| unknown())?;
        let state = status["state"].as_str().ok_or_else(unknown)?;
        if status["sessionId"] != sid
            || !matches!(
                state,
                "idle" | "running" | "cancelled" | "interrupted" | "closed"
            )
        {
            return Err(unknown());
        }
        let pid = match status.get("pid") {
            Some(Value::Null) => None,
            Some(v) => Some(
                v.as_u64()
                    .and_then(|n| u32::try_from(n).ok())
                    .filter(|&n| n > 0)
                    .ok_or_else(unknown)?,
            ),
            None => return Err(unknown()),
        };
        Ok(json!({"sessionId":sid,"state":state,"pid":pid}))
    }

    fn secret(&self) -> Result<Secret, ExecutorError> {
        Secret::new(self.identity.token.clone()).map_err(|_| unavailable())
    }

    pub async fn execute(
        &self,
        role: &Role,
        text: &str,
        mut cancel: watch::Receiver<bool>,
    ) -> Result<String, ExecutorError> {
        if !role.skills.is_empty()
            || !role.mcp_servers.is_empty()
            || role.model.as_deref() != Some(&self.identity.model)
        {
            return Err(ExecutorError::Launch(
                "冻结角色与 Runtime 模型或能力不匹配".into(),
            ));
        }
        let secret = self.secret()?;
        let prompt = json!([{"type":"text","text":text}]);
        if prompt.to_string().len() > MAX - 1024 {
            return Err(ExecutorError::Launch("ACP prompt 超限".into()));
        }
        let mut socket = timeout(CONTROL, async {
            let stream = TcpStream::connect(self.identity.address).await.ok()?;
            let mut request = format!("ws://{}/acp", self.identity.address)
                .into_client_request()
                .ok()?;
            let mut auth = format!("Bearer {}", self.identity.token)
                .parse::<tokio_tungstenite::tungstenite::http::HeaderValue>()
                .ok()?;
            auth.set_sensitive(true);
            request.headers_mut().insert("Authorization", auth);
            let limits = WebSocketConfig::default()
                .max_message_size(Some(MAX))
                .max_frame_size(Some(MAX));
            client_async_with_config(request, stream, Some(limits))
                .await
                .ok()
                .map(|(ws, _)| ws)
        })
        .await
        .ok()
        .flatten()
        .ok_or_else(unavailable)?;
        let init = control(
            &mut socket,
            1,
            "initialize",
            json!({"protocolVersion":1,"clientCapabilities":{}}),
        )
        .await
        .map_err(|_| unavailable())?
        .ok_or_else(unavailable)?;
        if init["protocolVersion"] != 1 {
            return Err(unavailable());
        }
        let session = control(
            &mut socket,
            2,
            "session/new",
            json!({"cwd":"/ursi/workspace/repo","mcpServers":[]}),
        )
        .await
        .map_err(|_| unknown())?
        .ok_or_else(|| ExecutorError::DoNotRetry("Runtime 拒绝创建 ACP 会话".into()))?;
        let sid = session["sessionId"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 128)
            .ok_or_else(unknown)?;
        let params = json!({"sessionId":sid});
        let outcome = if *cancel.borrow() {
            Ok(Err(ExecutorError::DoNotRetry("ACP 任务已取消".into())))
        } else {
            timeout(Duration::from_secs(600), async {
                request(&mut socket, 3, "session/prompt", json!({"sessionId":sid,"prompt":prompt})).await?;
                let mut sent_cancel = false;
                let mut output = String::new();
                loop {
                    tokio::select! {
                        biased;
                        requested = async { cancel.wait_for(|x| *x).await.is_ok() }, if !sent_cancel => {
                            // 单一有序连接，cancel 不可能先于绑定的 prompt 到达。
                            if requested {
                                send_cancel(&mut socket, &params).await?;
                            }
                            sent_cancel = true;
                        }
                        msg = receive(&mut socket) => {
                            let msg = msg?;
                            if let Some(id) = msg.get("id") {
                                if id.as_u64() != Some(3) { continue; }
                                let response = response(msg)?;
                                let result = match response {
                                    Some(v) => match PromptOutcome::from_result(&v).map_err(|_| ())? {
                                        PromptOutcome::Completed => Ok(secret.redact(&output)),
                                        PromptOutcome::Cancelled => Err(ExecutorError::DoNotRetry("ACP 任务已取消".into())),
                                    },
                                    None => Err(ExecutorError::Execution("ACP 任务失败".into())),
                                };
                                return Ok(result);
                            }
                            if msg["method"] != "session/update" || msg["params"]["sessionId"] != sid { continue; }
                            let update = &msg["params"]["update"];
                            if update["sessionUpdate"] == "agent_message_chunk" && update["content"]["type"] == "text" {
                                let chunk = update["content"]["text"].as_str().ok_or(())?;
                                if chunk.len() > MAX - output.len() { return Err(()); }
                                output.push_str(chunk);
                            }
                        }
                    }
                }
            }).await.unwrap_or(Err(()))
        };
        // A lost response does not mean stopped. Never issue a second prompt.
        let result = outcome.map_err(|_| unknown())?;
        let closed = control(&mut socket, 4, "_ursi/session/close", params)
            .await
            .map_err(|_| unknown())?;
        if closed != Some(json!({})) {
            return Err(unknown());
        }
        result
    }
}

#[cfg(test)]
mod tests;

type Socket = WebSocketStream<TcpStream>;
async fn send_cancel(
    ws: &mut (impl futures_util::Sink<Message> + Unpin),
    params: &Value,
) -> Result<(), ()> {
    timeout(
        CONTROL,
        send(
            ws,
            json!({"jsonrpc":"2.0","method":"session/cancel","params":params}),
        ),
    )
    .await
    .map_err(|_| ())?
}
async fn send(ws: &mut (impl futures_util::Sink<Message> + Unpin), value: Value) -> Result<(), ()> {
    ws.send(Message::Text(value.to_string().into()))
        .await
        .map_err(|_| ())
}
async fn request(ws: &mut Socket, id: u64, method: &str, params: Value) -> Result<(), ()> {
    send(
        ws,
        json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}),
    )
    .await
}
async fn receive(ws: &mut Socket) -> Result<Value, ()> {
    loop {
        match ws.next().await.ok_or(())?.map_err(|_| ())? {
            Message::Text(text) => {
                let v: Value = serde_json::from_str(&text).map_err(|_| ())?;
                return if v["jsonrpc"] == "2.0" {
                    Ok(v)
                } else {
                    Err(())
                };
            }
            Message::Ping(_) => ws.flush().await.map_err(|_| ())?,
            Message::Pong(_) => (),
            _ => return Err(()),
        }
    }
}
// Called only for the expected request ID. None is a confirmed RPC rejection.
fn response(mut msg: Value) -> Result<Option<Value>, ()> {
    if msg.get("method").is_some() {
        return Err(());
    }
    match (msg.get("result"), msg.get("error")) {
        (Some(_), None) => Ok(Some(msg["result"].take())),
        (None, Some(e)) if e["code"].is_i64() && e["message"].is_string() => Ok(None),
        _ => Err(()),
    }
}
async fn control(
    ws: &mut Socket,
    id: u64,
    method: &str,
    params: Value,
) -> Result<Option<Value>, ()> {
    timeout(CONTROL, async {
        request(ws, id, method, params).await?;
        loop {
            let msg = receive(ws).await?;
            if msg["id"].as_u64() == Some(id) {
                return response(msg);
            }
        }
    })
    .await
    .map_err(|_| ())?
}
