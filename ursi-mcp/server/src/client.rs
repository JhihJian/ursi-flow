//! Short-lived platform sessions. rmcp owns MCP initialization, dispatch and typed requests.
mod catalog;
mod http;

use super::{
    Config, Error, McpPlatform, ProtocolStatus, SNAPSHOT_LIMIT, STANDARD, label, policy,
    unavailable,
};
use base64::Engine;
use rmcp::{
    ClientLifecycleMode, ClientServiceExt, RoleClient,
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
use std::{
    collections::HashSet,
    sync::{Arc, atomic::Ordering},
};

fn rpc_err() -> Error {
    unavailable("MCP 服务连接失败或协议响应无效")
}

pub(super) struct Session(
    RunningService<RoleClient, ClientConfig>,
    Option<Value>,
    http::Diagnostic,
);

impl Session {
    pub(super) async fn open(store: &McpPlatform, cfg: &Config) -> Result<Self, Error> {
        let (url, authorization) = policy::endpoint(store, cfg)?;
        let mut options = StreamableHttpClientTransportConfig::with_uri(url.as_str())
            .max_sse_event_size(SNAPSHOT_LIMIT);
        options.reinit_on_expired_session = false;
        options.allow_stateless = true;
        options.retry_config = Arc::new(NeverRetry::default());
        let http = http::BoundedHttp::new(
            url,
            authorization,
            cfg.settings.as_ref().unwrap_or(&Default::default()),
        )?;
        let discovery = http.discovery.clone();
        let used_initialize = http.used_initialize.clone();
        let diagnostic = http.diagnostic.clone();
        let transport = StreamableHttpClientTransport::with_client(http, options);
        let mut connection = ClientConfig::new(Default::default(), store.0.identity.clone())
            .with_protocol_version(ProtocolVersion::V_2025_11_25)
            .serve_with_lifecycle(
                transport,
                ClientLifecycleMode::Auto {
                    preferred_versions: vec![ProtocolVersion::V_2026_07_28],
                    legacy_version: Some(ProtocolVersion::V_2025_11_25),
                },
            )
            .await
            .map_err(|_| diagnostic.error("MCP 会话建立失败"))?;
        let discovery = if used_initialize.load(Ordering::Relaxed) {
            None
        } else if let Some(snapshot) = discovery.get() {
            Some(snapshot.clone())
        } else {
            let _ = connection.close().await;
            return Err(rpc_err());
        };
        let session = Self(connection, discovery, diagnostic);
        let supported = session.0.peer_info().is_some_and(|info| {
            matches!(
                info.protocol_version.as_str(),
                "2026-07-28" | "2025-11-25" | "2025-06-18" | "2025-03-26"
            )
        });
        if !supported {
            session.close().await;
            return Err(unavailable("MCP 会话协商的版本不受支持"));
        }
        Ok(session)
    }

    pub(super) fn info(&self) -> Result<Value, Error> {
        let info = self.0.peer_info().ok_or_else(rpc_err)?;
        let implementation = info.server_info.as_ref();
        if implementation.is_some_and(|i| !label(&i.name, 512) || !label(&i.version, 256)) {
            return Err(rpc_err());
        }
        Ok(json!({
            "name": implementation.map(|i| &i.name),
            "version": implementation.map(|i| &i.version),
            "title": implementation.and_then(|i| i.title.as_ref()),
            "discoveryMethod": if self.1.is_some() { "server/discover" } else { "initialize" },
            "supportedVersions": self.1.as_ref().map(|r| &r["supportedVersions"]),
            "declaredCapabilities": self.1.as_ref().map(|r| r["capabilities"].clone()).unwrap_or_else(|| json!(info.capabilities)),
            "instructions": info.instructions,
            "protocolVersion": info.protocol_version,
            "capabilities": {
                "resources": info.capabilities.resources.is_some(),
                "tools": info.capabilities.tools.is_some(),
                "prompts": info.capabilities.prompts.is_some(),
            },
        }))
    }

    pub(super) fn executor_protocol(&self) -> Result<ProtocolStatus, Error> {
        let info = self.0.peer_info().ok_or_else(rpc_err)?;
        if self.1.is_none() {
            return Ok(ProtocolStatus::Legacy);
        }
        Ok(
            match info
                .meta
                .as_ref()
                .and_then(|meta| meta.get("ursi/executorProtocol"))
            {
                Some(Value::String(version)) if version == "1" => ProtocolStatus::DeclaredV1,
                Some(Value::String(_)) => ProtocolStatus::UnsupportedVersion,
                Some(_) => ProtocolStatus::InvalidDeclaration,
                None => ProtocolStatus::NotDeclared,
            },
        )
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
                if let Some(title) = resource.title.filter(|s| label(s, 512)) {
                    entry["title"] = json!(title);
                }
                if let Some(size) = resource.size {
                    entry["size"] = json!(size);
                }
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
