//! Short-lived platform sessions. rmcp owns MCP initialization, dispatch and typed requests.
mod http;

use super::{Config, Error, SNAPSHOT_LIMIT, STANDARD, Store, label, policy, unavailable};
use crate::work::mcp_client_info;
use base64::Engine;
use rmcp::{
    RoleClient, ServiceExt,
    model::{
        ClientConfig, PaginatedRequestParams, ProtocolVersion, ReadResourceRequestParams,
        ResourceContents,
    },
    service::RunningService,
    transport::{
        StreamableHttpClientTransport, common::client_side_sse::NeverRetry,
        streamable_http_client::StreamableHttpClientTransportConfig,
    },
};
use serde_json::{Value, json};
use std::{collections::HashSet, sync::Arc};

fn rpc_err() -> Error {
    unavailable("MCP 服务连接失败或协议响应无效")
}

pub(super) struct Session(RunningService<RoleClient, ClientConfig>);

impl Session {
    pub(super) async fn open(store: &Store, cfg: &Config) -> Result<Self, Error> {
        let (url, authorization) = policy::endpoint(store, cfg)?;
        let mut options = StreamableHttpClientTransportConfig::with_uri(url.as_str())
            .max_sse_event_size(SNAPSHOT_LIMIT);
        options.reinit_on_expired_session = false;
        options.allow_stateless = true;
        options.retry_config = Arc::new(NeverRetry::default());
        let transport = StreamableHttpClientTransport::with_client(
            http::BoundedHttp::new(url, authorization)?,
            options,
        );
        let session = Self(
            mcp_client_info(ProtocolVersion::V_2025_11_25)
                .serve(transport)
                .await
                .map_err(|_| rpc_err())?,
        );
        let supported = session.0.peer_info().is_some_and(|info| {
            matches!(
                info.protocol_version.as_str(),
                "2025-11-25" | "2025-06-18" | "2025-03-26"
            )
        });
        if !supported {
            session.close().await;
            return Err(rpc_err());
        }
        Ok(session)
    }

    pub(super) fn info(&self) -> Result<Value, Error> {
        let info = self.0.peer_info().ok_or_else(rpc_err)?;
        let implementation = info.server_info.as_ref().ok_or_else(rpc_err)?;
        if !label(&implementation.name, 512) || !label(&implementation.version, 256) {
            return Err(rpc_err());
        }
        Ok(json!({
            "name": implementation.name,
            "version": implementation.version,
            "protocolVersion": info.protocol_version,
            "capabilities": {
                "resources": info.capabilities.resources.is_some(),
                "tools": info.capabilities.tools.is_some(),
                "prompts": info.capabilities.prompts.is_some(),
            },
        }))
    }

    pub(super) fn has_resources(&self) -> bool {
        self.0
            .peer_info()
            .is_some_and(|info| info.capabilities.resources.is_some())
    }

    fn require_resources(&self) -> Result<(), Error> {
        self.has_resources()
            .then_some(())
            .ok_or_else(|| unavailable("MCP 服务未声明资源能力"))
    }

    pub(super) async fn close(mut self) {
        let _ = self.0.close().await;
    }

    pub(super) async fn list(&self) -> Result<Vec<Value>, Error> {
        self.require_resources()?;
        let mut cursor = None;
        let mut seen = HashSet::new();
        let mut uris = HashSet::new();
        let mut rows = vec![];
        let mut bytes = 2;
        for _ in 0..32 {
            let result = self
                .0
                .list_resources(Some(PaginatedRequestParams::default().with_cursor(cursor)))
                .await
                .map_err(|_| rpc_err())?;
            for resource in result.resources {
                if rows.len() >= 1024 {
                    return Err(unavailable("MCP 资源列表超过上限"));
                }
                if !label(&resource.name, 512)
                    || !label(&resource.uri, 4096)
                    || !uris.insert(resource.uri.clone())
                {
                    return Err(rpc_err());
                }
                let mut entry = json!({"name":resource.name,"uri":resource.uri});
                if let Some(mime) = resource.mime_type {
                    if !label(&mime, 256) {
                        return Err(rpc_err());
                    }
                    entry["mimeType"] = json!(mime);
                }
                if let Some(description) = resource.description.filter(|text| text.len() <= 4096) {
                    entry["description"] = json!(description);
                }
                bytes += entry.to_string().len() + usize::from(!rows.is_empty());
                if bytes > SNAPSHOT_LIMIT {
                    return Err(unavailable("MCP 资源列表超过上限"));
                }
                rows.push(entry);
            }
            let Some(next) = result.next_cursor else {
                return Ok(rows);
            };
            if !label(&next, 4096) || !seen.insert(next.clone()) {
                return Err(unavailable("MCP 分页游标无效或重复"));
            }
            cursor = Some(next);
        }
        Err(unavailable("MCP 资源分页超过上限"))
    }

    pub(super) async fn read(&self, uri: &str) -> Result<Value, Error> {
        self.require_resources()?;
        let result = self
            .0
            .read_resource(ReadResourceRequestParams::new(uri))
            .await
            .map_err(|_| rpc_err())?;
        if result.contents.len() > 1024 {
            return Err(rpc_err());
        }
        let mut rows = Vec::with_capacity(result.contents.len());
        for content in result.contents {
            let (uri, mime, mut row) = match content {
                ResourceContents::TextResourceContents {
                    uri,
                    mime_type,
                    text,
                    ..
                } => (uri, mime_type, json!({"text":text})),
                ResourceContents::BlobResourceContents {
                    uri,
                    mime_type,
                    blob,
                    ..
                } if STANDARD.decode(&blob).is_ok() => (uri, mime_type, json!({"blob":blob})),
                _ => return Err(rpc_err()),
            };
            if !label(&uri, 4096) {
                return Err(rpc_err());
            }
            row["uri"] = json!(uri);
            if let Some(mime) = mime {
                if !label(&mime, 256) {
                    return Err(rpc_err());
                }
                row["mimeType"] = json!(mime);
            }
            rows.push(row);
        }
        let value = Value::Array(rows);
        if value.to_string().len() > SNAPSHOT_LIMIT {
            return Err(rpc_err());
        }
        Ok(value)
    }
}
