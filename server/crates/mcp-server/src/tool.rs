//! 工具定义与处理函数契约。

use crate::context::InvocationContext;
use crate::error::ToolError;
use serde::Serialize;
use serde_json::Value;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

/// 工具输出：JSON 形态，由 MCP 传输层按协议封装。
pub type ToolOutput = Value;

/// 处理函数返回的 boxed future。
pub type HandlerFuture<'a> =
    Pin<Box<dyn Future<Output = Result<ToolOutput, ToolError>> + Send + 'a>>;

/// 单个工具的异步处理函数契约。
#[async_trait::async_trait]
pub trait ToolHandler: Send + Sync {
    async fn invoke(&self, ctx: &InvocationContext, args: Value)
    -> Result<ToolOutput, ToolError>;
}

#[async_trait::async_trait]
impl<F> ToolHandler for F
where
    F: for<'a> Fn(&'a InvocationContext, Value) -> HandlerFuture<'a> + Send + Sync,
{
    async fn invoke(
        &self,
        ctx: &InvocationContext,
        args: Value,
    ) -> Result<ToolOutput, ToolError> {
        self(ctx, args).await
    }
}

/// 从闭包构造处理函数：闭包返回 boxed future，
/// 形如 `|ctx, args| Box::pin(async move { ... })`。
pub fn fn_handler<F>(f: F) -> Arc<dyn ToolHandler>
where
    F: for<'a> Fn(&'a InvocationContext, Value) -> HandlerFuture<'a> + Send + Sync + 'static,
{
    Arc::new(f)
}

/// 单个工具的注册单元。
#[derive(Clone)]
pub struct Tool {
    pub name: String,
    pub description: String,
    /// JSON Schema 形态的输入参数描述。
    pub input_schema: Value,
    pub handler: Arc<dyn ToolHandler>,
}

impl Tool {
    pub fn new(
        name: impl Into<String>,
        description: impl Into<String>,
        input_schema: Value,
        handler: Arc<dyn ToolHandler>,
    ) -> Self {
        Self {
            name: name.into(),
            description: description.into(),
            input_schema,
            handler,
        }
    }

    /// 工具清单条目：不含处理函数，供 `list_tools` 汇总。
    pub fn descriptor(&self) -> ToolDescriptor {
        ToolDescriptor {
            name: self.name.clone(),
            description: self.description.clone(),
            input_schema: self.input_schema.clone(),
        }
    }
}

impl std::fmt::Debug for Tool {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // handler 刻意不参与 Debug：它只是闭包/替身，不含可读状态。
        f.debug_struct("Tool")
            .field("name", &self.name)
            .field("description", &self.description)
            .field("input_schema", &self.input_schema)
            .finish_non_exhaustive()
    }
}

/// 工具清单条目（name/description/schema）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ToolDescriptor {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}
