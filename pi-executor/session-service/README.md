# Pi SDK 会话服务

服务在同一进程内调用 Pi SDK。外部任务和 [Pi Web 工作区](../README.md) 通过 HTTP 访问同一会话，运行实例与 Pi JSONL 历史由服务管理。服务可单独运行，也可在 `/` 托管 Pi Web。

## 启动

使用 Node.js 22.19 或更高版本，在 `pi-executor/session-service/` 中执行 `npm ci`，配置环境变量并执行 `npm start`。

| 环境变量 | 用途 |
| --- | --- |
| `PI_SESSION_STATE_DIR` | 必填。私有状态目录的绝对路径，应由服务账户持有且权限为 `0700`。目录不存在时服务会创建。 |
| `PI_SESSION_MODEL_URL` | 必填。OpenAI 兼容模型的基础 URL，例如 `https://provider.example/v1`。SDK 在其后请求 `chat/completions`。 |
| `PI_SESSION_MODEL`、`PI_SESSION_MODEL_KEY` | 必填。模型 ID 和服务端模型密钥。 |
| `PI_SESSION_WRITE_TOKEN`、`PI_SESSION_READ_TOKEN` | 外部 API 的对话和只读令牌，必须成对配置、彼此不同且各至少 24 个字符。仅使用受信 Web 入口时可同时省略。 |
| `PI_SESSION_WEB_ORIGIN`、`PI_SESSION_WEB_ACCESS` | 免登录入口的完整源和访问权限，例如 `https://pi.example.com` 配 `read` 或 `write`。源包含协议、主机和非默认端口，不带路径或末尾斜杠。未配置时仅接受 Bearer。 |
| `PI_SESSION_HOST`、`PI_SESSION_PORT` | 可选，默认 `127.0.0.1:30146`。 |
| `PI_SESSION_WEB_DIR` | 可选。根路径构建的前端 `out/` 绝对路径，须和状态目录分开。 |
| `PI_SESSION_REFERENCE_FILE` | 可选。服务启动时加载的 UTF-8 文本文件，最大 12,000 字节。配置后 Agent 可用 `read_reference` 读取，内容可出现在模型请求和会话历史中。 |

将免登录入口部署在受信网络内，或通过已有访问控制的网关提供。网关通过 HTTPS 接收请求，保留 Web 入口的 `Host`，关闭 SSE 响应缓冲，并限制后端端口仅供网关访问。来源检查用于限制浏览器跨站请求。入口的访问者共享同一权限和实例下的全部会话。`sessionId` 仅用于定位。需要隔离数据时使用独立实例和状态目录。Agent 接收文本，仅加载显式配置的模型和可选参考工具。

## HTTP 接口

下列路径均以 `/api/pi` 为前缀。外部调用带 `Authorization: Bearer <token>`。同源实时页带 `X-Pi-Web: 1`，免登录写请求还需匹配配置的 `Origin`。有 JSON 请求体时带 `Content-Type: application/json`。

| 方法与路径 | 最低权限 | 成功响应 |
| --- | --- | --- |
| `GET /access` | 只读 | `200`，`{ "canWrite": false }` 或 `{ "canWrite": true }`。 |
| `GET /runtime` | 只读 | `200`，服务默认配置。 |
| `GET /sessions/:id/runtime` | 只读 | `200`，会话生效配置。未捕获生效配置时返回服务默认配置。 |
| `GET /sessions` | 只读 | `200`，`{ sessions: [...] }`，按更新时间倒序。 |
| `GET /sessions/:id` | 只读 | `200`，当前快照。带 `?entry=<entryId>` 时返回截至该消息的历史快照。 |
| `GET /sessions/:id/structure` | 只读 | `200`，`{ activeLeafId, nodes, forkedFrom, forks }`。 |
| `GET /sessions/:id/events` | 只读 | `200`，SSE，先发送当前快照，随后随会话更新发送新的快照。 |
| `POST /sessions` | 对话 | `201`，会话摘要。请求体为 `{}` 或 `{ "title": "任务名称" }`。 |
| `POST /sessions/:id/prompt` | 对话 | `202`，已受理。请求体为 `{ "message": "任务内容" }`。 |
| `POST /sessions/:id/cancel` | 对话 | `202`，已请求停止。最终状态从快照读取。 |
| `POST /sessions/:id/fork` | 对话 | `201`，派生会话摘要。请求体为 `{ "entryId": "消息条目 ID" }`。 |

配置响应包含 `scope`、`systemPrompt`、`model`、`tools`、`skills` 和 `mcp`。`scope: "service"` 表示服务默认值。`scope: "session"` 表示来自当前运行或上次运行的配置。模型字段含 ID、名称、提供方、上下文窗口和输出上限。只有显式配置参考文件时才可使用 `read_reference`。服务不加载技能或 MCP，两者均返回空数组。配置响应不包含密钥、模型端点、私有目录、参考文件路径或内容。

会话摘要含 `id`、`title`、`updatedAt`（Unix 毫秒）和 `status`。状态包括 `idle`、`running`、`completed`、`failed`、`cancelled` 和 `interrupted`。快照包含当前路径末尾最多 100 条公开 `messages`、与之逐条对应的稳定 `entryIds`、正在生成的 `partial` 和当前运行的 `activeTool`。历史快照不包含实时输出或活动工具。SSE 每个 `data` 帧携带一份 JSON 快照，慢连接在恢复时获得最新状态。连接中断后重新订阅即可，命令与订阅彼此独立。

结构中的 `nodes` 包含 `id`、`parentId`、`role` 和截取后的 `text`。根节点的 `parentId` 为 `null`。`activeLeafId` 对应实时路径的最后一条公开消息。`forkedFrom` 记录来源会话和条目，`forks` 列出由此会话派生的子会话。历史预览使用条目 ID 读取路径，不移动实时末端。派生复制从根至选中条目的路径，返回新会话 ID，保留复制消息的条目 ID。读取和派生都不会启动 Agent 或请求模型。

无有效凭据且不匹配免登录入口时返回 `401`。来源不匹配或只读访问提交命令时返回 `403`，未知会话或消息条目返回 `404`。向运行中的会话提交新消息或派生会话，向正在派生的会话提交新消息，或向空闲会话发出停止命令，均返回 `409`。实例执行或订阅容量已满时返回 `429`。命令受理后由服务异步执行，以快照中的终态为准。

## 从外部提交并分享会话

下面的示例使用预先配置的 `PI_SESSION_WRITE_TOKEN` 和 `jq`：

```bash
api=http://127.0.0.1:30146/api/pi
session_id=$(curl -fsS "$api/sessions" \
  -H "Authorization: Bearer $PI_SESSION_WRITE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"title":"外部任务"}' | jq -er '.id')
curl -fsS "$api/sessions/$session_id/prompt" \
  -H "Authorization: Bearer $PI_SESSION_WRITE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"message":"请整理三个交付检查项"}'
```

通过受信 Web 入口分享 `/?session=<id>` 链接。API 调用方也可使用只读令牌直接订阅同一 ID 的 SSE。

## 重启与验证

服务启动时加载会话索引。历史读取直接投影已落盘的消息。只有显式提交提示词才创建 Agent。正常退出会请求停止正在运行的任务。异常退出后，已落盘的历史保持可读，未完成的运行显示为 `interrupted`。状态目录内的 `.session-owner` 用于保证单进程持有会话。异常退出后如有残留，先确认原进程已退出，再移除该空目录并启动服务。

运行 `npm test` 进行集成验证。测试使用回环地址上的假 OpenAI SSE 模型，覆盖中途观察、工具结果、超大快照、权限拒绝、并发冲突、会话续聊、运行配置、历史预览、派生和重启后的条目寻址。
