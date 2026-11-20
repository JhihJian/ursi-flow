//! MCP Streamable HTTP：每次操作建立短会话，不追随重定向，不把对端错误正文返回给用户。
use super::{Config, Error, SNAPSHOT_LIMIT, STANDARD, Store, label, policy, unavailable};
use base64::Engine;
use eventsource_stream::Eventsource;
use futures_util::{StreamExt, TryStreamExt};
use reqwest::{
    Client, Method, RequestBuilder, Response, Url,
    header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderValue},
    redirect::Policy,
};
use serde_json::{Value, json};
use std::{collections::HashSet, time::Duration};

const VERSIONS: [&str; 3] = ["2025-11-25", "2025-06-18", "2025-03-26"];
fn rpc_err() -> Error {
    unavailable("MCP 服务连接失败或协议响应无效")
}

pub(super) struct Session {
    http: Client,
    url: Url,
    headers: HeaderMap,
    id: u64,
}
impl Session {
    pub(super) async fn open(store: &Store, cfg: &Config) -> Result<Self, Error> {
        let (url, bearer) = policy::endpoint(store, cfg)?;
        let http = Client::builder()
            .no_proxy()
            .redirect(Policy::none())
            .connect_timeout(Duration::from_secs(3))
            .timeout(Duration::from_secs(8))
            .build()
            .map_err(|_| rpc_err())?;
        let mut headers = HeaderMap::new();
        headers.insert(
            ACCEPT,
            HeaderValue::from_static("application/json, text/event-stream"),
        );
        if let Some(token) = bearer {
            headers.insert(AUTHORIZATION, token);
        }
        let mut s = Self {
            http,
            url,
            headers,
            id: 0,
        };
        let init=s.rpc("initialize",json!({"protocolVersion":VERSIONS[0],"capabilities":{},"clientInfo":{"name":"ursi-workbench","version":env!("CARGO_PKG_VERSION")}})).await?;
        let ver = init["protocolVersion"]
            .as_str()
            .filter(|v| VERSIONS.contains(v))
            .ok_or_else(rpc_err)?;
        if !init["capabilities"]["resources"].is_object() {
            return Err(unavailable("MCP 服务未声明资源能力"));
        }
        s.headers.insert(
            "mcp-protocol-version",
            HeaderValue::from_str(ver).map_err(|_| rpc_err())?,
        );
        let ack = s
            .request(Method::POST)
            .json(&json!({"jsonrpc":"2.0","method":"notifications/initialized"}))
            .send()
            .await
            .map_err(|_| rpc_err())?;
        if !ack.status().is_success() {
            return Err(rpc_err());
        }
        Ok(s)
    }
    fn request(&self, method: Method) -> RequestBuilder {
        self.http
            .request(method, self.url.clone())
            .headers(self.headers.clone())
    }
    pub(super) async fn close(&self) {
        if self.headers.contains_key("mcp-session-id") {
            let _ = self
                .request(Method::DELETE)
                .timeout(Duration::from_secs(1))
                .send()
                .await;
        }
    }
    async fn rpc(&mut self, method: &str, params: Value) -> Result<Value, Error> {
        self.id += 1;
        let resp = self
            .request(Method::POST)
            .json(&json!({"jsonrpc":"2.0","id":self.id,"method":method,"params":params}))
            .send()
            .await
            .map_err(|_| rpc_err())?;
        if !resp.status().is_success() {
            return Err(rpc_err());
        }
        if method == "initialize" {
            if let Some(id) = resp.headers().get("mcp-session-id") {
                if id.is_empty()
                    || id.len() > 512
                    || !id.as_bytes().iter().all(u8::is_ascii_graphic)
                {
                    return Err(rpc_err());
                }
                self.headers.insert("mcp-session-id", id.clone());
            }
        }
        response(resp, self.id).await
    }
    pub(super) async fn list(&mut self) -> Result<Vec<Value>, Error> {
        let mut params = json!({});
        let mut seen = HashSet::new();
        let mut rows = vec![];
        let mut bytes = 0;
        for _ in 0..32 {
            let result = self.rpc("resources/list", params).await?;
            for row in result["resources"].as_array().ok_or_else(rpc_err)? {
                if rows.len() >= 1024 {
                    return Err(unavailable("MCP 资源列表超过上限"));
                }
                let mut entry = json!({"name":field(row,"name",512)?,"uri":field(row,"uri",4096)?});
                if row.get("mimeType").is_some() {
                    entry["mimeType"] = json!(field(row, "mimeType", 256)?);
                }
                bytes += entry.to_string().len();
                if bytes > SNAPSHOT_LIMIT {
                    return Err(unavailable("MCP 资源列表超过上限"));
                }
                rows.push(entry);
            }
            if result.get("nextCursor").is_none() {
                return Ok(rows);
            }
            let cursor = field(&result, "nextCursor", 4096)?;
            if !seen.insert(cursor.to_owned()) {
                return Err(unavailable("MCP 分页游标重复"));
            }
            params = json!({"cursor":cursor});
        }
        Err(unavailable("MCP 资源分页超过上限"))
    }
    pub(super) async fn read(&mut self, uri: &str) -> Result<Value, Error> {
        let result = self.rpc("resources/read", json!({"uri":uri})).await?;
        let parts = result["contents"]
            .as_array()
            .filter(|p| p.len() <= 1024)
            .ok_or_else(rpc_err)?;
        let mut rows = vec![];
        for p in parts {
            let mut part = json!({"uri":field(p,"uri",4096)?});
            if p.get("mimeType").is_some() {
                part["mimeType"] = json!(field(p, "mimeType", 256)?);
            }
            match (p.get("text"), p.get("blob")) {
                (Some(Value::String(text)), None) => part["text"] = json!(text),
                (None, Some(Value::String(blob))) if STANDARD.decode(blob).is_ok() => {
                    part["blob"] = json!(blob)
                }
                _ => return Err(rpc_err()),
            }
            rows.push(part);
        }
        Ok(Value::Array(rows))
    }
}
fn field<'a>(v: &'a Value, key: &str, max: usize) -> Result<&'a str, Error> {
    v[key]
        .as_str()
        .filter(|s| label(s, max))
        .ok_or_else(rpc_err)
}
async fn response(resp: Response, id: u64) -> Result<Value, Error> {
    let mime = resp
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let mut total = 0;
    let mut stream = resp
        .bytes_stream()
        .map_err(|_| rpc_err())
        .and_then(move |chunk| {
            total += chunk.len();
            std::future::ready(if total > SNAPSHOT_LIMIT {
                Err(unavailable("MCP 响应超过 4 MiB"))
            } else {
                Ok(chunk)
            })
        });
    let mut msg: Value = match mime.as_str() {
        "application/json" => {
            let mut buf = vec![];
            while let Some(chunk) = stream.try_next().await? {
                buf.extend_from_slice(&chunk);
            }
            serde_json::from_slice(&buf).map_err(|_| rpc_err())?
        }
        "text/event-stream" => {
            let mut events = stream.eventsource();
            loop {
                let e = events
                    .next()
                    .await
                    .ok_or_else(rpc_err)?
                    .map_err(|_| rpc_err())?;
                if e.event != "message" || e.data.is_empty() {
                    continue;
                }
                let v: Value = serde_json::from_str(&e.data).map_err(|_| rpc_err())?;
                if v["id"] == id {
                    break v;
                }
            }
        }
        _ => return Err(rpc_err()),
    };
    if msg["jsonrpc"] != "2.0"
        || msg["id"] != id
        || msg.get("error").is_some()
        || !msg["result"].is_object()
    {
        return Err(rpc_err());
    }
    Ok(msg["result"].take())
}
