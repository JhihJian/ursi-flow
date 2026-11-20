---
parent: ../../../SPEC.md
references:
  - ../../../DESIGN-v2.md
  - HTTP.md
  - ../../../../EXECUTOR-DESIGN.md
  - ../../../../PI-AGENT-EXECUTOR-DESIGN.md
---

# 工作定义目录

## 功能意图

分别发布资源与执行器定义，通过修订号读取历史内容。

## 关键功能与验收

### 发布与读取

#### 验收

- 下表的 `{collection}` 为 `resources` 或 `executors`，路径相对 `/api/v2`。发布成功返回新版本正文，修订号由服务端从 1 递增。失败不占用版本号。

| 方法 | 路径 | 结果 |
| --- | --- | --- |
| POST | `/{collection}` | 校验并发布请求中的定义 |
| GET | `/{collection}` | 所有对象的最新版数组，含当前 `active` 状态 |
| GET | `/{collection}/{id}` | 对象最新版，含 `active` |
| GET | `/{collection}/{id}/revisions` | 按版本从早到晚列出冻结正文 |
| GET | `/{collection}/{id}/revisions/{revision}` | 指定版本的冻结正文 |
| POST | `/{collection}/{id}/deactivate` | 停用整个 ID，新发布及新引用返回 409，历史读取不变 |

- 资源 `prompt`、`skill` 接受非空文本；`mcp` 只接受形如 `{"serverRef":"tools","credentialRef":"tools-auth"}` 的命名引用，`credentialRef` 可省略。连接参数和凭据由管理员管理。当前执行后端均不支持注入 MCP，绑定时拒绝发布。
- 普通执行器接受 `id`、可选的 `resources` 和 `configSchema`。Agent 执行器接受 `id`、可选的 `resources` 和必填的 `agent`。定义不接受 `kind`、`environment`、`flowId`、`flowRevision`、程序、路径、命令或环境变量字段。
- `configSchema` 支持字段数组或 `{fields:[...]}`。每个字段包含 `key`、`label`、`type`，可选 `description`、`required`、`default`、`options`、`min`、`max`。字段类型支持 `string`、`url`、`secret`、`enum`、`integer`、`number`、`boolean`、`configPackage`。它不是任意 JSON Schema，不支持对象、数组、组合、表达式或执行配置。
- `url` 默认值必须是无空白的绝对 URL；`enum` 必须有非空且不重复的字符串 `options`；`integer` 和 `number` 可声明有限的 `min`、`max`，且默认值必须在边界内；`configPackage` 默认值必须是不含路径的配置包标识。未声明 `default` 的字段没有默认值。
- `secret` 只能使用 `"***"`、`{"redacted":true}` 或命名的内部引用 `{"ref":"secret://..."}` 表示。明文密钥、路径、命令和环境变量均拒绝，secret 值不进入普通响应。

### 执行器的资源引用

#### 验收

- 每个资源引用必须指定 `{id, revision}`。未知修订、已停用资源、MCP 资源或同一资源的冲突版本均不能用于发布新执行器。
- 已发布的修订保留当时的资源引用，历史读取不受后续更新或停用影响。

### Agent 配置与管理员授权

#### 验收

- 选项接口只列出管理员策略中的模型 ID 和只读工具 ID。策略文件必须通过绝对路径打开，是权限为 `0600` 的私有普通文件。
- 发布和草稿预览都校验固定指令、受管模型、所选工具和 `skill` 修订。引用 `prompt` 或 `mcp`、指定未授权模型或工具、传入路径或命令字段时拒绝请求。
- 预览只返回配置快照。发布在同一次存储更新中保存公开修订与私有快照，只分配一个执行器修订号。公开修订保留请求中的 `agent`，快照冻结 Skill 正文与工具参数 schema 摘要。凭据和连接参数只保存在管理员文件。
- 已发布快照按执行器 ID 和修订读取，后续策略或 Skill 变更不改写快照。执行器停用后，读取运行快照返回冲突，公开历史仍可查。
