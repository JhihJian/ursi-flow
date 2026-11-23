# 资源与执行器定义 HTTP 契约

本文保留 Workbench 前端引用的契约路径。以下为[执行器平台](../../../../../executor-platform/server/README.md)的**管理员**接口，路径相对于平台 `/api/v2`，`collection` 为 `resources` 或 `executors`。Workbench 与 Runtime 的服务令牌只能读取执行器选择所需的 `id`、`revision`、Agent 标记及最新版的 `active`，不返回资源正文、配置包引用或后端绑定。

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

`POST /api/v2/executors` 的 Agent 定义和 `PUT /api/v2/executor-attempts/{id}` 的 `previewDefinition` 使用相同对象：

```json
{
  "id": "ticket-review",
  "agent": {"configPackageId": "<配置包记录的 id>"}
}
```

`agent.backendId` 是可选的后端 ID。发布和试跑时服务端从已通过检查且兼容本次快照的后端中选择：省略 ID 时，无候选返回 503，多个候选返回 409；显式指定的 ID 不存在返回 404，不兼容返回 400，未就绪返回 503。[后端目录的兼容性查询](../../../../../executor-platform/server/src/work/agent_backends/README.md#http-接口)只解析包，不要求已有就绪后端。

`configPackageId` 为平台内已登记配置包的标识，区别于 `directoryId`。未知配置包、工作包 ID 或目录 ID 返回 404。内联字段、`resources`（包括空数组）和 `configSchema` 返回 400。普通执行器的定义格式保持不变。

服务端与目录 API 共用存储锁，整份解析期间目录不可写入。文件约定如下：

| 包内路径 | 在快照中的用途 |
| --- | --- |
| `AGENTS.md` | 提示词，保留 UTF-8 原文。新包中的空文件须先填写。 |
| `skills/<name>/SKILL.md` | 每个直接子目录必须有此入口。按目录名排序并冻结各 Skill 下的配套文件、相对路径和摘要；`skills/` 顶层平铺的 `.md` 不视为 Skill。 |
| `mcp.json` | 顶层对象，仅接受可选的 `modelProfile`、`tools`、`mcpServers`。 |

例如 `{"modelProfile":"managed","tools":["tickets.get"],"mcpServers":{}}`。省略 `modelProfile` 时选择管理员策略 `models` 数组的第一项，数组为空则返回 400。`tools` 默认为 `[]`，显式指定时须为不重复的受权工具 ID 数组。`mcpServers` 只支持空对象；非空对象返回 400，服务端不会启动其中的命令或使用其连接参数。显式 `null` 不表示省略。

提示词及每个 Skill 必须有非空白 UTF-8 正文，单篇最多 256 KiB，Skill 和工具各最多 64 个，完整快照最多 2 MiB。正文无效、缺少入口、配置格式错误或未获授权均拒绝发布，不分配修订号。

发布成功返回带 `revision` 和实际 `agent.backendId` 的定义，即使请求未指定后端。ACP 协议标记、后端 ID、程序路径和策略路径单独绑定到该修订，只在服务端存储。列表、详情和历史使用相同的公开定义。冻结内容见 [ACP 配置契约](../../../../../docs/design/executor-platform/ACP-PROFILE.md#agent-配置与生效条件)。草稿试跑读取当时的包文件，不发布定义。已发布 ACP 修订使用原快照，不依赖最近一次预检；绑定失效返回 503，不改选其他后端。旧 MCP 修订只保留历史，须重新发布 ACP 修订才能用于新尝试。

`schemaDigest` 是 `inputSchema` 递归按对象键排序、保留数组顺序后，紧凑 UTF-8 JSON 的 SHA-256 小写十六进制字符串。

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
