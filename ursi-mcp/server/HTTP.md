# 平台 MCP HTTP 契约

路径以宿主挂载在 `/api/v2` 为例。宿主负责认证并限定能管理服务和凭据的调用方。

## MCP 管理 API

| 方法与路径 | 输入或输出 |
| --- | --- |
| `GET /api/v2/mcp-servers` | 返回服务记录数组。 |
| `POST /api/v2/mcp-servers` | 输入 `{name,url,credentialEnv?,binding?}`，返回含 `id` 的服务记录。只登记配置，不发起连接。 |
| `DELETE /api/v2/mcp-servers/{id}` | 删除登记，返回 `{id}`。旧工作包保留生成来源。 |
| `GET /api/v2/mcp-servers/{id}/inspection` | 返回 `{server,resources}`。`server` 含当前 `protocolVersion`、`discoveryMethod`、`supportedVersions`、自报的 `name/version/title`、`declaredCapabilities`、`instructions` 和三个常用能力标记。旧握手的 `supportedVersions` 为 null；未声明资源能力时不发送列表请求。 |
| `GET /api/v2/mcp-servers/{id}/resources` | 新建会话并翻页，返回 `[{name,title?,uri,mimeType?,description?,size?}]`。 |
| `POST /api/v2/mcp-servers/{id}/resources/read` | 输入 `{uri}`，返回 `{contents:[{uri,mimeType?,text|blob}]}`。只用于界面预览，不写工作项或目录。 |

连接使用官方 Rust MCP SDK `rmcp` 的 Streamable HTTP 客户端，先用 `2026-07-28` 的 `server/discover` 查询；旧握手协商 `2025-11-25`、`2025-06-18` 或 `2025-03-26`。初始化后携带协商版本及服务端给出的会话 ID。有会话 ID 时限时尝试 `DELETE`。响应可通过 JSON 或发起请求的 POST 所对应的 SSE 返回，不发起后台 GET，也不重连或重放。资源发现最多 32 页、1024 条，最多等待 25 秒。发现、读取预览、工具与提示词操作及宿主批量读取共享每实例 4 个并发名额。远端 JSON-RPC 错误不回显原文。

资源预览复用同一条授权与限额链路：每次预览新建会话、只发 `resources/read`，响应仍受 4 MiB 上限约束。界面把 `text` 按原文展示，不解释 Markdown 或 HTML；`blob` 只显示大小。预览不是生成的前置步骤，宿主在生成时会自行重新读取。

## 工具、提示词与资源模板

在服务检查页切换「工具目录」「提示词目录」或「资源模板」时才请求该目录。三类发现复用已登记的端点、凭据、短会话与限额。每页按游标继续，最多 32 页、1024 项、合计 4 MiB。工具保留输入 schema，提示词保留参数说明，模板保留 URI 模式。目录可刷新。

以下路径接在 `/api/v2/mcp-servers/{id}` 后：

| 操作 | 请求与结果 |
| --- | --- |
| `GET /catalog/{kind}` | `kind` 为 `tools`、`prompts`、`templates`，返回相应 MCP 目录项数组。 |
| `PUT /settings` | 完整替换 `{allowedTools,githubToolsets,githubReadOnly}`，返回保存值。缺省为空列表和 `false`。 |
| `POST /tools/call` | `{name,arguments}`，参数为 JSON 对象，返回工具原始 MCP 结果，包括 `isError`。 |
| `POST /prompts/get` | `{name,arguments}`，参数值为字符串，返回 MCP 消息，按数据展示。 |

工具表格的「允许调用」开关修改当前服务的本地精确名称白名单。仅发现或配置远端工具集不会授权。每次手动调用须确认，后端检查白名单；若存在部署策略文件，匹配的授权条目还须含 `allowedTools` 并列出该名称。调用不重试，超时需先核实远端状态。工作包配方、Flow 和执行器不会自动获得这些工具。

官方默认 GitHub 端点 `https://api.githubcopilot.com/mcp/` 的「工具设置」可按行启停 `repos`、`issues` 等工具集并设置只读模式。清空显式选择恢复 GitHub 默认工具集。它们映射到 `X-MCP-Toolsets` 和 `X-MCP-Readonly`；其他服务不能设置这些头。只读开关由 GitHub 实施，实际权限还受 PAT 和组织策略限制。

当前平台使用远程 Streamable HTTP 短会话。资源模板通过输入展开后的 URI 读取，未实现长连接订阅、变更通知、客户端采样、交互式输入或本地 stdio 进程托管。
