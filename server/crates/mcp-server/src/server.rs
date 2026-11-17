//! `McpServer`：协议无关的工具装配与进程内 JSON-RPC 式调用骨架。
//!
//! server 的真实 MCP 传输在 transport 模块接入，本结构只约定调用面：
//! 装配时选域注册，调用时按名路由，参数校验层在路由前剔除身份参数。

use crate::context::{detect_identity_args, InvocationContext};
use crate::domains::{Domain, DomainId};
use crate::error::{AssemblyError, ToolError};
use crate::tool::{ToolDescriptor, ToolOutput};
use serde_json::Value;
use std::collections::HashMap;

/// 协议无关的 MCP 工具面 server。
#[derive(Clone, Debug, Default)]
pub struct McpServer {
    domains: HashMap<DomainId, Domain>,
    /// 按装配顺序排列的域标识，保证 list_tools 输出稳定。
    order: Vec<DomainId>,
    tools: HashMap<String, DomainId>,
}

impl McpServer {
    /// 按 `domains` 顺序装配并注册各域工具。
    ///
    /// 装配顺序即工具清单顺序。同名工具或同一域重复装配都是装配错误，
    /// 返回 [`AssemblyError`]。
    pub fn register_domain(domains: &[Domain]) -> Result<Self, AssemblyError> {
        let mut server = McpServer {
            domains: HashMap::new(),
            order: Vec::new(),
            tools: HashMap::new(),
        };
        for domain in domains {
            let id = domain.id();
            if server.domains.contains_key(&id) {
                return Err(AssemblyError::DuplicateDomain { domain: id });
            }
            for tool in domain.tools() {
                if let Some(existing) = server.tools.get(&tool.name) {
                    return Err(AssemblyError::DuplicateTool {
                        tool: tool.name.clone(),
                        existing: *existing,
                        incoming: id,
                    });
                }
                server.tools.insert(tool.name.clone(), id);
            }
            server.domains.insert(id, domain.clone());
            server.order.push(id);
        }
        Ok(server)
    }

    /// 装配单域的便捷入口。
    pub fn with_domain(domain: Domain) -> Result<Self, AssemblyError> {
        Self::register_domain(&[domain])
    }

    /// server 当前暴露的域。
    pub fn registered_domains(&self) -> &[DomainId] {
        &self.order
    }

    /// 汇总域工具清单；装配多个域时可指定单域查看。
    ///
    /// 传 `None` 返回全部已装配域的工具；传未装配的域返回空清单
    ///（未装配的域对调用方完全不可见，见 SPEC 验收）。
    pub fn list_tools(&self, domain: Option<DomainId>) -> Vec<ToolDescriptor> {
        let ids: Vec<DomainId> = match domain {
            Some(id) => {
                if self.domains.contains_key(&id) {
                    vec![id]
                } else {
                    Vec::new()
                }
            }
            None => self.order.clone(),
        };
        let mut descriptors = Vec::new();
        for id in ids {
            let Some(d) = self.domains.get(&id) else {
                continue;
            };
            let mut tools: Vec<ToolDescriptor> = d.tools().iter().map(|t| t.descriptor()).collect();
            descriptors.append(&mut tools);
        }
        descriptors
    }

    /// 按工具名路由到所属域执行。
    ///
    /// 工具名不存在（含未装配域的工具）一律 [`ToolError::UnknownTool`]。
    /// 内部域调用在路由前做身份参数校验：args 顶层携带 run_id 等身份键
    /// 直接拒绝，不进入 backend。
    pub async fn invoke(
        &self,
        name: &str,
        ctx: Option<&InvocationContext>,
        args: Value,
    ) -> Result<ToolOutput, ToolError> {
        let Some(&domain_id) = self.tools.get(name) else {
            return Err(ToolError::UnknownTool {
                name: name.to_string(),
            });
        };

        let domain = self
            .domains
            .get(&domain_id)
            .expect("tool registry and domain map built together");

        // 参数校验层：内部域禁止从 args 明文传入运行身份。
        if matches!(domain_id, DomainId::Internal) {
            let offenders = detect_identity_args(&args);
            if !offenders.is_empty() {
                return Err(ToolError::ForbiddenIdentityArgs { keys: offenders });
            }
        }

        let detached;
        let ctx = match ctx {
            Some(c) => c,
            None => {
                detached = InvocationContext::detached_placeholder();
                &detached
            }
        };
        domain.invoke(name, ctx, args).await
    }
}
