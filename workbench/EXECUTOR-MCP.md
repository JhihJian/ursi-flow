# Workbench 执行器 MCP 契约

Workbench 通过一个管理员指定的本机可执行文件启动、查询和取消尝试。**一次尝试由 `attemptId` 标识，一次 stdio 会话只调用一个工具。** 执行器必须能在新进程中按同一 ID 找回运行，也要能在启动回执丢失后接收同参数的启动请求而不重复执行。Flow 是这个契约的[参考实现](FLOW-EXECUTOR-DESIGN.md)。

## 部署与目录

管理员将 `URSI_EXECUTOR_BIN` 设为受信可执行文件的绝对路径。Workbench 直接以无参数方式启动它。HTTP 调用方不能指定命令、环境变量、Flow 或宿主路径。这个执行入口独立于[平台只读 MCP 服务注册表](server/src/work/mcp/PLATFORM.md)，无需在那里登记或授权工具。

客户端清空继承环境，再设置以下变量。`URSI_API_TOKEN` 等父进程凭据不传给执行器。

| 子进程变量 | 值或来源 |
| --- | --- |
| `PATH` | 固定为 `/usr/local/bin:/usr/bin:/bin` |
| `URSI_EXECUTOR_ROOT` | Workbench 提供的私有尝试根目录 |
| `URSI_EXECUTOR_FLOW`、`URSI_EXECUTOR_FLOW_REVISION`、`URSI_FLOW_HOME` | 仅在服务环境中已设置时放行。Flow 适配器分别用作 Flow ID、固定目录修订和 daemon 所在的绝对目录 |

`attemptId` 必须是带连字符的小写 UUID（十六进制分组 `8-4-4-4-12`）。以下两个引用必须精确匹配请求中的 ID：

| 工具引用 | 宿主位置 | 约定 |
| --- | --- | --- |
| `workspace:<attemptId>` | `<URSI_EXECUTOR_ROOT>/<attemptId>/workspace` | `inputs/` 存放本次准备的工作包输入；未指定工作包时从空输入开始 |
| `artifacts:<attemptId>` | 同一 workspace 的 `artifacts/` | 只向此处写本次要发布的文件，报告终态前结束写入 |

平台复制材料和收集制品时，仅接受目录和无硬链接的普通文件，拒绝符号链接和特殊文件。每次复制最多 4096 个条目、32 层、单文件 8 MiB、合计 64 MiB。执行器应先校验 ID 与引用，再在已知根下定位目录，拒绝越界或符号链接。这个布局用于分开各次尝试的材料与输出；本机执行器仍须受信，工作目录本身不提供进程沙箱。

## 单次调用的线协议

Workbench 使用官方 Rust MCP SDK `rmcp` 建立客户端会话，传输固定为 MCP **`2025-06-18`**。stdin/stdout 使用 UTF-8 JSON-RPC 2.0，每条消息单独一行，以换行结束并及时刷新。stdout 专用于协议，客户端丢弃 stderr。`tools/call` 可携带标准 `_meta` 对象，由协议层接收，不作为执行器业务参数。会话顺序如下：

1. 客户端发送 `initialize`（`id: 1`），参数含 `protocolVersion`、`capabilities: {}` 和 `clientInfo: {name,version}`。服务端回同一 ID，`result` 含同一版本、`capabilities: {tools: {}}` 和字符串 `serverInfo.name`、`serverInfo.version`。
2. 客户端发送无 ID 的 `notifications/initialized`，服务端无需回复。随后客户端直接发 `tools/call`（`id: 2`），参数为 `{name,arguments}`。工具名固定，不依赖发现；参考实现也支持 `tools/list`。
3. 服务端回同一 ID 的 `result`。客户端关闭 stdin，服务端应在 EOF 后正常退出（退出码 0）。后台任务须能独立继续。握手、调用和等待进程退出合计限时 15 秒，超时回收子进程，不自动重放请求。

请求帧最多 4 MiB（含换行）；每次等待一个响应也只有 4 MiB 的读取预算，最多读 32 行，前置 `notifications/*` 也计入。超限、ID 不匹配、无效握手、JSON-RPC `error` 或异常退出均按协议不可用处理。会话失败本身不能证明后端未执行。

## 三个工具

| `name` | `arguments`（仅列出的字段） | 行为 |
| --- | --- | --- |
| `executor_start` | `attemptId`、`workspaceRef`、`artifactDirectoryRef`、`workInstruction: {text,encoding}` | `text` 为字符串，`encoding` 固定 `"utf-8"`。以 ID 为幂等键登记或返回已有运行；同 ID 的输入或绑定不同应报告 `conflict` |
| `executor_inspect` | `{attemptId}` | 查询原运行，可跨 stdio 进程；找不到时报告 `not_found`，不补启动 |
| `executor_cancel` | `{attemptId}` | 核对运行归属后请求停止，返回实际状态；已完成的任务不能仅因收到取消请求就改报 `cancelled` |

例如，下面是一条完整的启动请求。输入工作包由 Workbench 准备，`workPatchId` 不进入 MCP 参数。

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"executor_start","arguments":{"attemptId":"123e4567-e89b-12d3-a456-426614174000","workspaceRef":"workspace:123e4567-e89b-12d3-a456-426614174000","artifactDirectoryRef":"artifacts:123e4567-e89b-12d3-a456-426614174000","workInstruction":{"text":"检查材料并写出 report.txt","encoding":"utf-8"}}}}
```

三个工具使用同一结果形状：成功的 `result` 必须有 `content` 数组、对象 `structuredContent`，`isError` 省略或为 `false`。Workbench 读取 `structuredContent`，其中 `attemptId` 和 `artifactDirectoryRef` 对应原请求，`backendRunRef` 是可选的不透明字符串。参考实现还在 `content` 中返回同值 JSON text；客户端接受的最小响应示例：

```json
{"jsonrpc":"2.0","id":2,"result":{"content":[],"structuredContent":{"attemptId":"123e4567-e89b-12d3-a456-426614174000","status":"running","artifactDirectoryRef":"artifacts:123e4567-e89b-12d3-a456-426614174000"}}}
```

`status` 取 `running`、`succeeded`、`failed`、`cancelled` 或 `unverified`。其中 `succeeded`、`failed`、`cancelled` 是已确认终态。`unverified` 表示暂时无法核实，可再次 inspect。工具执行成功和工作成功是两回事：查询到失败的运行仍返回成功的工具结果，`status` 为 `failed`。

工具错误使用 `result.isError: true`，`content` 恰含一个 `text` 项，`text` 本身是含 `code` 的 JSON 对象序列化后的字符串：

```json
{"jsonrpc":"2.0","id":2,"result":{"isError":true,"content":[{"type":"text","text":"{\"code\":\"not_found\"}"}]}}
```

`invalid` 表示参数无效，`conflict` 表示身份、输入或修订冲突，`not_found` 表示目标不存在，`busy` 表示繁忙，`unavailable` 表示服务不可用。不要将凭据、宿主路径或后端原始错误装入响应。未知错误码或畸形结果按不可用处理。

## HTTP 调用与制品发布

以下路径均在 `/api/v2` 下，需要 `Authorization: Bearer <URSI_API_TOKEN>`。调用方先生成并保存小写 UUID；即使未收到首次 HTTP 回执，也能用这个 ID 查询。

| 方法与路径 | 请求与语义 |
| --- | --- |
| `PUT /executor-attempts/{attemptId}` | JSON 如 `{"workInstruction":{"text":"检查材料并写出 report.txt","encoding":"utf-8"},"workPatchId":"包标识"}`。指令正文必须非空且不超过 256 KiB，`workPatchId` 是可选字符串。首次冻结输入并启动；同 ID、同参数查回原尝试，必要时可用相同 PUT 显式重发同 ID 的幂等启动。更换指令或工作包返回 409 |
| `GET /executor-attempts/{attemptId}` | 读取原尝试，按需查询后端并收集制品。启动回执丢失、状态为 `starting`、`running` 或 `unverified` 时，继续用 GET 核对，不会触发启动 |
| `POST /executor-attempts/{attemptId}/cancel` | 无需正文。请求取消原尝试；以返回或后续查询确认的状态为准 |

HTTP 尝试记录中的 `artifactDirectoryRef` 从启动起就能标识输出位置。**只有确认终态并收集了 `artifacts/` 后，才发布只读 `artifactDirectoryId`。** 收到 ID 后用 `GET /api/v2/directories/{artifactDirectoryId}/tree` 列文件，用同目录的 `/file?path=report.txt` 取原始字节；写入返回 409。不要用 `artifacts:<attemptId>` 代替目录 ID。轮询和收集按请求推进，无需假定有常驻的监控任务。

协议对照：[Workbench stdio 客户端](server/src/work/executor/client.rs)、[Flow 工具与封装](../flow-runtime/src/integrations/mcp/stdio.ts)、[Flow 参数校验与状态映射](../flow-runtime/src/integrations/mcp/executor.ts)、[HTTP 端到端用例](server/tests/executor_mcp_e2e.py)。
