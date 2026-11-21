# 执行器 MCP 的发现与列表标签

## 方案

`ursi-mcp` 检查已登记的 Streamable HTTP 服务，将上次成功检查得到的执行器协议声明保存在登记记录中。列表在服务名旁显示「执行器 v1」。标签表示服务在检查时自报支持 [执行器 MCP 协议第 1 版](../../EXECUTOR-MCP.md#协议发现)，与当前在线状态、工具合规检查和调用权限独立。

## 检查入口

- 列表行提供「检查协议」。新登记和已有登记使用同一个入口。检查成功后读取保存结果并更新标签，失败时显示错误和重试入口。登记、打开列表和「刷新登记」保持零出站请求。
- 服务详情显示最近成功检查的时间和结果，并提供「重新检查协议」。列表标签的辅助说明注明「上次检查时服务自报」。
- 协议检查只协商 MCP 会话并读取发现响应，独立于资源浏览。资源目录不可用或服务只有工具能力时，仍可检查声明。首版只支持已登记的 HTTP 端点，本地 stdio 执行器沿用现有入口。

## 识别规则

复用 [Session::open](../../../ursi-mcp/server/src/client.rs) 建立会话，并沿用 `Session::info` 对发现方式的区分。会话通过 `server/discover` 成功协商后，从 `rmcp` 保留的 `peer_info().meta` 读取 `ursi/executorProtocol`，无需记录原始 `_meta` 或发送第二次发现请求。旧 `initialize` 返回的同名元数据不参与识别。

| 检查结果 | 保存的 `status` | 列表标签 |
| --- | --- | --- |
| 值严格等于 JSON 字符串 `"1"` | `declaredV1` | 执行器 v1 |
| 键缺失 | `notDeclared` | 无 |
| 其他字符串版本 | `unsupportedVersion` | 无 |
| 值存在但类型错误，例如数字 `1` | `invalidDeclaration` | 无 |
| 回退到旧 `initialize` 并成功协商 | `legacy` | 无 |
| 超时、连接失败或 MCP 响应无效 | 保留上次成功记录，当前请求报错 | 保留上次标签 |

执行器识别只读取协议声明，不根据工具名或服务名推断。将来需要额外检查三个工具及 `runConfig` schema 时，可复用 `tools/list`，并在界面上与「服务自报」分开呈现。协议检查不发送 `tools/call`，不改变现有调用许可。

## 接口与保存

- 新增 `POST /api/v2/mcp-servers/{id}/protocol-check`，无需请求体，按登记 ID 检查并保存，返回 `{status, checkedAt}`，时间为 Unix 毫秒。复用既有的策略、凭据、25 秒时限和每实例四个操作名额。原 `GET /inspection` 继续处理实时发现和资源列表，不写入协议检查记录。
- `GET /api/v2/mcp-servers` 的记录增加只读可选字段 `protocolCheck`，形状与 POST 返回相同。无字段表示尚未完成一次成功检查。登记仍使用 `Config`，服务端生成检查字段，只保存归一化结果和时间，不保存原始元数据。
- `ServerRepository` 增加按 ID 更新检查结果的操作。独立版在 `store.json` 中保存，Workbench 在 `work.json` 的 `mcpServers` 中保存，沿用各自的锁和原子写入。检查期间不持有存储锁，同一 ID 同时只运行一次检查，写回只修改仍存在的记录，不覆盖并行保存的设置。已有登记无需重登。

## SDK 互操作

[executor-sdk](../../../executor-sdk/index.js) 的 `server/discover` 响应包含 `ttlMs: 0` 和 `cacheScope: "private"`，以匹配 `rmcp` 的发现结果结构。管理接口的返回值和错误语义见 [HTTP 契约](../../../ursi-mcp/server/HTTP.md)。
