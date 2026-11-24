# Pi SDK 会话服务

服务在同一进程内调用 Pi SDK。外部任务和 [Pi Web 实时页](../README.md) 通过 HTTP 访问同一会话，运行时实例与 Pi JSONL 历史由服务管理。服务可单独运行，也可为实时页提供同源静态文件。

## 启动

使用 Node.js 22.19 或更高版本，在 `pi-executor/session-service/` 中执行 `npm ci`，配置环境变量并执行 `npm start`。

| 环境变量 | 用途 |
| --- | --- |
| `PI_SESSION_STATE_DIR` | 必填。私有状态目录的绝对路径，应由服务账户持有且权限为 `0700`。目录不存在时服务会创建。 |
| `PI_SESSION_MODEL_URL` | 必填。OpenAI 兼容模型的基础 URL，例如 `https://provider.example/v1`。SDK 在其后请求 `chat/completions`。 |
| `PI_SESSION_MODEL`、`PI_SESSION_MODEL_KEY` | 必填。模型 ID 和服务端模型密钥。 |
| `PI_SESSION_WRITE_TOKEN`、`PI_SESSION_READ_TOKEN` | 必填。分别用于对话和只读的随机令牌，必须不同且各至少 24 个字符。 |
| `PI_SESSION_HOST`、`PI_SESSION_PORT` | 可选，默认 `127.0.0.1:30146`。 |
| `PI_SESSION_WEB_DIR` | 可选。根路径构建的前端 `out/` 绝对路径，须和状态目录分开。 |
| `PI_SESSION_REFERENCE_FILE` | 可选。服务启动时加载的 UTF-8 文本文件，最大 12,000 字节。配置后 Agent 可用 `read_reference` 读取，内容可出现在模型请求和会话历史中。 |

跨机器访问时由 HTTPS 反向代理转发，并关闭 SSE 响应缓冲。两个令牌均可查看该实例下的所有会话，`sessionId` 仅用于定位。需要隔离数据的调用方应使用独立实例和独立状态目录。Agent 接收文本，仅加载显式配置的模型和可选参考工具。

## HTTP 接口

下列路径均以 `/api/pi` 为前缀。每次请求带 `Authorization: Bearer <token>`。有 JSON 请求体时带 `Content-Type: application/json`。

| 方法与路径 | 最低权限 | 成功响应 |
| --- | --- | --- |
| `GET /access` | 只读 | `200`，`{ "canWrite": false }` 或 `true`。 |
| `GET /sessions` | 只读 | `200`，`{ sessions: [...] }`，按更新时间倒序。 |
| `GET /sessions/:id` | 只读 | `200`，当前快照。 |
| `GET /sessions/:id/events` | 只读 | `200`，SSE，先发送当前快照，随后随会话更新发送新的快照。 |
| `POST /sessions` | 对话 | `201`，会话摘要。请求体为 `{}` 或 `{ "title": "任务名称" }`。 |
| `POST /sessions/:id/prompt` | 对话 | `202`，已受理。请求体为 `{ "message": "任务内容" }`。 |
| `POST /sessions/:id/cancel` | 对话 | `202`，已请求停止。最终状态从快照读取。 |

会话摘要含 `id`、`title`、`updatedAt`（Unix 毫秒）和 `status`。状态包括 `idle`、`running`、`completed`、`failed`、`cancelled` 和 `interrupted`。快照还包含最新 100 条公开消息、正在生成的 `partial` 和当前运行的 `activeTool`。SSE 每个 `data` 帧携带一份 JSON 快照，慢连接在恢复时获得最新状态。连接中断后重新订阅即可；命令与事件流彼此独立。

无有效令牌返回 `401`，只读令牌提交命令返回 `403`，未知会话返回 `404`。向运行中的会话提交新消息，或向空闲会话发出停止命令，返回 `409`。实例执行或订阅容量已满时返回 `429`。命令受理后由服务异步执行，以快照中的终态为准。

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

分享前端 `/live/?session=<id>` 链接，通过独立渠道提供只读令牌。API 调用方也可使用只读令牌直接订阅同一 ID 的 SSE。

## 重启与验证

服务启动时加载会话索引。历史读取直接投影已落盘的消息；只有显式提交才会打开 Pi 会话。正常退出会请求停止正在运行的任务。异常退出后，已落盘的历史保持可读，未完成的运行显示为 `interrupted`。状态目录内的 `.session-owner` 用于保证单进程持有会话。异常退出后如有残留，先确认原进程已退出，再移除该空目录并启动服务。

运行 `npm test` 进行集成验证。测试使用回环地址上的假 OpenAI SSE 模型，覆盖中途观察、工具结果、超大快照、权限拒绝、并发冲突、会话续聊与重启历史。
