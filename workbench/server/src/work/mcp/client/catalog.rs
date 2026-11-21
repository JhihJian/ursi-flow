use super::super::operations::{Catalog, Input};
use super::*;
use rmcp::model::{CallToolRequestParams, GetPromptRequestParams};

impl Session {
    fn require(&self, kind: Catalog) -> Result<(), Error> {
        let caps = &self.0.peer_info().ok_or_else(rpc_err)?.capabilities;
        if match kind {
            Catalog::Prompts => caps.prompts.is_some(),
            Catalog::Tools => caps.tools.is_some(),
            Catalog::Templates => caps.resources.is_some(),
        } {
            Ok(())
        } else {
            Err(unavailable("服务未声明此 MCP 能力"))
        }
    }
    pub(in super::super) async fn catalog(&self, kind: Catalog) -> Result<Value, Error> {
        self.require(kind)?;
        let mut cursor = None;
        let mut cursors = HashSet::new();
        let mut keys = HashSet::new();
        let mut rows = Vec::new();
        let mut bytes = 2;
        for _ in 0..32 {
            let params = Some(PaginatedRequestParams::default().with_cursor(cursor));
            let (items, next) = match kind {
                Catalog::Tools => {
                    let r = self.0.list_tools(params).await.map_err(|_| rpc_err())?;
                    (json!(r.tools), r.next_cursor)
                }
                Catalog::Prompts => {
                    let r = self.0.list_prompts(params).await.map_err(|_| rpc_err())?;
                    (json!(r.prompts), r.next_cursor)
                }
                Catalog::Templates => {
                    let r = self
                        .0
                        .list_resource_templates(params)
                        .await
                        .map_err(|_| rpc_err())?;
                    (json!(r.resource_templates), r.next_cursor)
                }
            };
            for entry in items.as_array().ok_or_else(rpc_err)? {
                let key = entry[if kind == Catalog::Templates {
                    "uriTemplate"
                } else {
                    "name"
                }]
                .as_str()
                .ok_or_else(rpc_err)?;
                bytes += entry.to_string().len() + 1;
                if !label(key, 4096)
                    || !keys.insert(key.to_owned())
                    || bytes > SNAPSHOT_LIMIT
                    || rows.len() >= 1024
                {
                    return Err(unavailable("MCP 目录无效或超过上限"));
                }
                rows.push(entry.clone());
            }
            let Some(next) = next else {
                return Ok(Value::Array(rows));
            };
            if !label(&next, 4096) || !cursors.insert(next.clone()) {
                return Err(rpc_err());
            }
            cursor = Some(next);
        }
        Err(unavailable("MCP 目录分页超过上限"))
    }
    pub(in super::super) async fn call(&self, input: Input) -> Result<Value, Error> {
        self.require(Catalog::Tools)?;
        let r = self
            .0
            .call_tool_once(CallToolRequestParams::new(input.name).with_arguments(input.arguments))
            .await
            .map_err(|_| unavailable("工具调用未取得有效响应，请核实远端状态后再操作"))?;
        match r {
            rmcp::model::CallToolResponse::Complete(result) => Ok(json!(result)),
            _ => Err(unavailable(
                "工具需要额外交互或异步任务处理，本次未继续提交",
            )),
        }
    }
    pub(in super::super) async fn prompt(&self, input: Input) -> Result<Value, Error> {
        self.require(Catalog::Prompts)?;
        let r = self
            .0
            .get_prompt_once(
                GetPromptRequestParams::new(input.name).with_arguments(input.arguments),
            )
            .await
            .map_err(|_| rpc_err())?;
        match r {
            rmcp::model::GetPromptResponse::Complete(result) => Ok(json!(result)),
            _ => Err(unavailable("提示词需要额外交互，本次未继续提交")),
        }
    }
}
