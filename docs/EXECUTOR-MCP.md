# 执行器 MCP 协议

## 职责

执行器在调用方准备的工作区里按指令执行任务，把产物写入指定目录，并报告执行状态。调用方负责准备输入和目录，在执行器确认终态后收集产物。

一次执行称为一次**尝试**，由调用方分配唯一的 `attemptId`。执行器支持按这个 ID 启动、查询和取消尝试。任务独立于连接：启动回执丢失后，调用方可以重新连接并查询原尝试。

## 操作

| MCP 工具 | 参数（仅接受所列字段） | 执行器的行为 |
| --- | --- | --- |
| `executor_start` | `attemptId`、`workspaceRef`、`artifactDirectoryRef`、`workInstruction`，可选 `runConfig` | 登记并启动。相同 ID、输入和执行绑定返回原尝试，不重复执行。已登记的 ID 用于不同输入或绑定时返回 `conflict`。 |
| `executor_inspect` | `attemptId` | 查询原尝试的实际状态。找不到时返回 `not_found`，不补启动。 |
| `executor_cancel` | `attemptId` | 核对归属并请求停止，返回实际状态。只有确认取消才报告 `cancelled`；已经结束的尝试保留原结果。 |

`attemptId` 是带连字符的小写 UUID（`8-4-4-4-12`）。`workInstruction` 是任务指令字符串。工作区和产物目录引用分别为 `workspace:<attemptId>` 和 `artifacts:<attemptId>`，两者必须与本次 ID 一致。

`runConfig` 是本次尝试的运行配置，直接传 JSON 对象。具体执行器定义可用字段及其含义，并在启动前校验。不支持的字段、无效值或非对象配置（包括 `null`）返回 `invalid`。省略等同于 `{}`，使用执行器默认配置。

首次启动时固定本次配置。以同一 `attemptId` 重试时，按 JSON 内容比较 `runConfig`，对象键顺序不影响比较。配置不同则返回 `conflict`，沿用原尝试的配置和状态。

本机 stdio 执行器从 `URSI_EXECUTOR_ROOT` 指定的私有根目录解析引用：工作区为 `<根目录>/<attemptId>/workspace`，其中 `inputs/` 存放输入，`artifacts/` 存放产物。执行器先校验 ID 和引用，再定位目录，拒绝越界或符号链接，并在报告终态前结束对产物的写入。工作目录不提供进程沙箱。

## 状态与错误

三个工具返回相同的状态对象：`attemptId`、`status`、`artifactDirectoryRef`，以及可选的不透明运行标识 `backendRunRef`。`attemptId` 和 `artifactDirectoryRef` 均须对应请求中的尝试。

| `status` | 含义 |
| --- | --- |
| `running` | 正在执行。 |
| `succeeded`、`failed`、`cancelled` | 已确认终态，分别表示成功、失败、已取消。 |
| `unverified` | 暂时无法核实。调用方可继续查询。 |

查到失败的任务仍是一次成功的查询，返回 `status: "failed"`。只有工具调用本身失败才返回工具错误。

## stdio 消息

使用 MCP `2025-06-18`，每行一条 UTF-8 JSON-RPC 2.0 消息，换行后及时刷新。stdout 专用于协议。一次会话执行一次工具调用：

1. 调用方发送 `initialize`，含协议版本、`capabilities: {}` 和 `clientInfo: {name,version}`。执行器以相同请求 ID 返回同一版本、`capabilities: {tools: {}}` 和 `serverInfo: {name,version}`。
2. 调用方发送无 ID 的 `notifications/initialized`，随后发送 `tools/call`。标准 `_meta` 由 MCP 层处理，不属于工具参数。探测接口时只发 `tools/list`，首个列表响应须包含上述三个工具各一次，探测不创建尝试。
3. 执行器以相同请求 ID 返回结果。调用方关闭 stdin，执行器的 stdio 进程在 EOF 后正常退出。后台任务可以继续运行。握手、调用及退出合计限时 15 秒，超时回收 stdio 进程，不自动重放请求。

启动请求示例（此执行器支持 `reportFormat` 配置）：

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"executor_start","arguments":{"attemptId":"123e4567-e89b-12d3-a456-426614174000","workspaceRef":"workspace:123e4567-e89b-12d3-a456-426614174000","artifactDirectoryRef":"artifacts:123e4567-e89b-12d3-a456-426614174000","workInstruction":"检查材料并写出报告","runConfig":{"reportFormat":"markdown"}}}}
```

成功响应的 `result` 含 `content` 数组和 `structuredContent` 状态对象，`isError` 省略或为 `false`。调用方读取 `structuredContent`；`content` 可以为空，也可以附上同值的 JSON 文本。

```json
{"jsonrpc":"2.0","id":2,"result":{"content":[],"structuredContent":{"attemptId":"123e4567-e89b-12d3-a456-426614174000","status":"running","artifactDirectoryRef":"artifacts:123e4567-e89b-12d3-a456-426614174000"}}}
```

工具错误使用 `isError: true`，`content` 恰含一个 `text` 项，其文本为序列化的 JSON 错误对象：

```json
{"jsonrpc":"2.0","id":2,"result":{"isError":true,"content":[{"type":"text","text":"{\"code\":\"not_found\"}"}]}}
```

公开错误码为 `invalid`（参数无效）、`conflict`（输入或绑定冲突）、`not_found`（找不到尝试）、`busy`（繁忙）、`unavailable`（服务不可用）。响应不得包含凭据、宿主路径或后端原始错误。

请求帧最多 4 MiB（含换行）。每次等待响应最多读取 4 MiB、32 行，前置通知计入限额。超限、请求 ID 不匹配、无效握手、JSON-RPC `error`、未知错误码、畸形结果或异常退出均按不可用处理。连接故障不能证明任务未执行。
