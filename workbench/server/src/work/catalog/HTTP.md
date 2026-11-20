# 资源与执行器定义 HTTP 契约

`collection` 为 `resources` 或 `executors`，路径相对于 `/api/v2`。

| 方法 | 路径 | 结果 |
| --- | --- | --- |
| POST | `/{collection}` | 校验并发布新修订，修订号由服务端分配 |
| GET | `/{collection}` | 各 ID 的最新版数组，含 `active` |
| GET | `/{collection}/{id}` | 最新版，含 `active` |
| GET | `/{collection}/{id}/revisions` | 从早到晚列出所有修订 |
| GET | `/{collection}/{id}/revisions/{revision}` | 指定修订正文 |
| POST | `/{collection}/{id}/deactivate` | 停用 ID，保留历史 |

例如，先发布资源 `{"id":"guide","kind":"skill","content":"列出材料及核查结果。"}`，再发布引用其首版的执行器：

```json
{
  "id": "assistant",
  "resources": [{"id": "guide", "revision": 1}],
  "configSchema": {"fields": [
    {"key": "retries", "label": "重试次数", "type": "integer", "min": 0, "max": 5, "default": 2}
  ]}
}
```

## Agent 执行器

`GET /api/v2/agent-options` 返回可选标识，例如 `{"models":[{"id":"managed"}],"tools":[{"id":"tickets.get"}]}`。未设置策略时两个数组均为空。接口不返回 provider、工具地址、远端工具名、参数 schema 或凭据。

`POST /api/v2/executors` 示例：

```json
{
  "id": "ticket-review",
  "resources": [{"id": "guide", "revision": 1}],
  "agent": {"systemPrompt": "逐项核对工单。", "modelProfile": "managed", "tools": ["tickets.get"]}
}
```

`agent` 的三个字段均必填：`systemPrompt` 是非空正文，按原文保存；`modelProfile` 是受管模型 ID；`tools` 是不重复的只读工具 ID 数组，可为 `[]`。`resources` 可省略，只接受固定修订的 `skill`。`prompt` 资源返回 400，固定指令应写入 `systemPrompt`。Agent 定义不接受 `configSchema`、程序、命令、路径、连接参数或其他扩展字段。

发布成功返回请求正文和 `revision`。列表、详情和历史使用相同的公开定义。服务端在该修订下私存 `{systemPrompt,modelProfile,skills:[{id,revision,content}],tools:[{id,schemaDigest}]}`。`schemaDigest` 是 `inputSchema` 递归按对象键排序、保留数组顺序后，紧凑 UTF-8 JSON 的 SHA-256 小写十六进制字符串。

### 管理员策略

将 `URSI_PI_POLICY` 设为 JSON 文件的绝对路径。文件由服务账户或 root 持有，权限必须为 `0600`，上限 2 MiB，文件本身不得为符号链接。策略示例：

```json
{
  "models": [{"id": "managed", "provider": {"model": "review-model"}}],
  "tools": [{"id": "tickets.get", "url": "https://tools.example.test/mcp", "name": "getTicket", "inputSchema": {"type": "object"}, "readOnly": true}]
}
```

模型和工具的 ID 在各自列表内唯一。`url` 使用 HTTP(S)，`token` 是可选的私有令牌。选项、发布和预览每次读取当前策略；文件不可读、权限或内容无效时返回 503。请求选择了未授权模型或工具时返回 400，不产生修订。运行时调用工具仍需核验当前授权，并与冻结的摘要比对。

配置字段、资源种类和引用校验规则见[定义规格](SPEC.md)。工作包与配置包使用独立的[包接口](../patches/HTTP.md)。
