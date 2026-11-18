//! 只投影平台使用的 v1 字段。响应允许新增字段，但已消费的字段必须合法。

use std::collections::BTreeMap;

use flow_core::sandboxes::{
    EndpointView, GatewayError, GatewaySandboxStatus, GatewaySandboxView, SandboxSpec, Visibility,
};
use serde::{Deserialize, Serialize};

#[derive(Serialize)]
pub(super) struct Create<'a> {
    image: &'a str,
    command: &'a [String],
    labels: &'a BTreeMap<String, String>,
    ports: Vec<Port<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    memory_mb: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cpus: Option<f64>,
    bundle: Option<Bundle<'a>>,
    runtime_profile: Option<&'a str>,
}

#[derive(Serialize)]
struct Port<'a> {
    name: &'a str,
    port: u16,
    visibility: WireVisibility,
    ready: bool,
}

#[derive(Serialize)]
struct Bundle<'a> {
    url: &'a str,
    sha256: &'a str,
    min_image_level: u32,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum WireVisibility {
    Public,
    Internal,
}

impl<'a> TryFrom<&'a SandboxSpec> for Create<'a> {
    type Error = GatewayError;
    fn try_from(s: &'a SandboxSpec) -> Result<Self, Self::Error> {
        // serde_json 会把非有限浮点数写成 null，不能改变冻结规格的含义。
        if s.cpus.is_some_and(|v| !v.is_finite()) {
            return Err(GatewayError::Protocol("CPU 限制必须为有限数值".into()));
        }
        Ok(Self {
            image: &s.image,
            command: &s.command,
            labels: &s.labels,
            ports: s
                .ports
                .iter()
                .map(|p| Port {
                    name: &p.name,
                    port: p.port,
                    visibility: match p.visibility {
                        Visibility::Public => WireVisibility::Public,
                        Visibility::Internal => WireVisibility::Internal,
                    },
                    ready: p.ready,
                })
                .collect(),
            memory_mb: s.memory_mb,
            cpus: s.cpus,
            bundle: s.bundle.as_ref().map(|b| Bundle {
                url: &b.url,
                sha256: &b.sha256,
                min_image_level: b.min_image_level,
            }),
            runtime_profile: s.runtime_profile.as_deref(),
        })
    }
}

#[derive(Deserialize)]
pub(super) struct ErrorBody {
    pub error: ErrorDetail,
}

#[derive(Deserialize)]
pub(super) struct ErrorDetail {
    pub code: String,
    pub message: String,
}

#[derive(Deserialize)]
pub(super) struct Sandbox {
    pub id: String,
    status: Status,
    // 不使用 Option 的缺省值：只有显式的 null 才是“无待处理操作”。
    #[serde(deserialize_with = "Option::deserialize")]
    operation: Option<Operation>,
    endpoints: Vec<Endpoint>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Status {
    Preparing,
    Running,
    Stopped,
    Deleting,
    Error,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Operation {
    Create,
    Start,
    Stop,
    Delete,
    Rebuild {
        #[serde(rename = "previous")]
        _previous: Resource,
        #[serde(rename = "preserve_data")]
        _preserve_data: bool,
    },
}

#[derive(Deserialize)]
struct Resource {
    #[serde(rename = "generation")]
    _generation: u64,
    #[serde(rename = "data_generation")]
    _data_generation: u64,
}

#[derive(Deserialize)]
struct Endpoint {
    name: String,
    port: u16,
    visibility: WireVisibility,
    address: String,
}

pub(super) fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.trim() == id
        && !matches!(id, "." | "..")
        && !id.chars().any(char::is_control)
}

impl Sandbox {
    pub fn validate(&self, expected_id: Option<&str>) -> Result<(), GatewayError> {
        if !valid_id(&self.id) || expected_id.is_some_and(|id| id != self.id) {
            return Err(GatewayError::Protocol(
                "Gateway 响应中的沙箱标识无效或与请求不符".into(),
            ));
        }
        for endpoint in &self.endpoints {
            if endpoint.port == 0
                || endpoint.name.trim().is_empty()
                || endpoint.address.trim().is_empty()
            {
                return Err(GatewayError::Protocol("Gateway 响应中的端点无效".into()));
            }
        }
        Ok(())
    }

    pub fn has_delete_intent(&self) -> bool {
        matches!(self.operation, Some(Operation::Delete))
    }
}

impl From<Sandbox> for GatewaySandboxView {
    fn from(s: Sandbox) -> Self {
        Self {
            id: s.id,
            status: match s.status {
                Status::Preparing => GatewaySandboxStatus::Preparing,
                Status::Running => GatewaySandboxStatus::Running,
                Status::Stopped => GatewaySandboxStatus::Stopped,
                Status::Deleting => GatewaySandboxStatus::Deleting,
                Status::Error => GatewaySandboxStatus::Error,
            },
            operation_pending: s.operation.is_some(),
            endpoints: s
                .endpoints
                .into_iter()
                .map(|e| EndpointView {
                    name: e.name,
                    port: e.port,
                    visibility: match e.visibility {
                        WireVisibility::Public => Visibility::Public,
                        WireVisibility::Internal => Visibility::Internal,
                    },
                    address: e.address,
                })
                .collect(),
        }
    }
}
