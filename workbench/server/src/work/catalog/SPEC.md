---
parent: ../../../../../executor-platform/server/SPEC.md
depends-on:
  - ../agent_backends/SPEC.md
references:
  - ../../../../../docs/design/workbench/SERVER-WORK-MANAGEMENT.md
  - HTTP.md
  - ../generation/GENERATORS-HTTP.md
  - ../../../../../docs/design/workbench/EXECUTOR-DESIGN.md
  - ../../../../../docs/design/workbench/PI-AGENT-EXECUTOR-DESIGN.md
---

# 工作定义目录

## 功能意图

执行器平台发布资源与执行器，通过修订号读取历史内容。此规格保留在 Workbench 前端引用的旧路径；工作包生成器由 Workbench 单独发布，见[生成器契约](../generation/GENERATORS-HTTP.md)。

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
- 普通执行器接受 `id`、可选的 `resources` 和 `configSchema`。Agent 执行器只接受 `id` 和 `agent: {configPackageId, backendId?}`。定义不接受 `kind`、`environment`、`flowId`、`flowRevision`、程序、路径、命令或环境变量字段。
- `configSchema` 支持字段数组或 `{fields:[...]}`。每个字段包含 `key`、`label`、`type`，可选 `description`、`required`、`default`、`options`、`min`、`max`。字段类型支持 `string`、`url`、`secret`、`enum`、`integer`、`number`、`boolean`、`configPackage`。它不是任意 JSON Schema，不支持对象、数组、组合、表达式或执行配置。
- `url` 默认值必须是无空白的绝对 URL；`enum` 必须有非空且不重复的字符串 `options`；`integer` 和 `number` 可声明有限的 `min`、`max`，且默认值必须在边界内；`configPackage` 默认值必须是不含路径的配置包标识。未声明 `default` 的字段没有默认值。
- `secret` 只能使用 `"***"`、`{"redacted":true}` 或命名的内部引用 `{"ref":"secret://..."}` 表示。明文密钥、路径、命令和环境变量均拒绝，secret 值不进入普通响应。

### 消费者选版

#### 验收

- 使用 Workbench 或 Runtime 的服务令牌查询 `/executors` 及其修订，只返回公开选择信息。消费者凭固定 `{id, revision}` 启动尝试，无权读取管理定义、发布或停用对象。

### 执行器的资源引用

#### 验收

- 每个资源引用必须指定 `{id, revision}`。未知修订、已停用资源、MCP 资源或同一资源的冲突版本均不能用于发布新执行器。
- 已发布的修订保留当时的资源引用，历史读取不受后续更新或停用影响。

### Agent 配置与管理员授权

#### 验收

- 选项接口只列出管理员策略中的模型 ID 和只读工具 ID。策略文件必须通过绝对路径打开，是权限为 `0600` 的私有普通文件。
- Agent 发布与 `previewDefinition` 使用同一契约，只能引用已登记的配置包。服务端在同一把 Store 锁内定位目录、读取 `AGENTS.md`、各直接 Skill 子目录的 `SKILL.md` 及 `mcp.json`。平铺文件与附属文件不注入。内联配置、`resources`、路径或工作包引用均被拒绝。
- `mcp.json` 可选择受权的模型和只读工具。省略模型时取管理员策略声明的首个模型，省略工具时使用空列表。无可用模型、未授权或重复工具、非空 `mcpServers`、未知字段均使解析失败。
- 预览只生成本次尝试的快照，不占用修订号。发布原子保存含包引用及所选 `backendId` 的公开定义、私有部署绑定和配置快照，冻结提示词、Skill 正文、模型 ID 及工具参数 schema 摘要。凭据和连接参数只保存在管理员文件。
- 发布和试跑只选已通过可用性检查且兼容快照的后端。显式 ID 必须满足两项条件；省略 ID 时必须恰有一个候选。兼容性列表可独立解析配置包，即使没有就绪后端也可列出。
- 已发布修订按 ID 和版本直接使用原快照，包括旧内联格式发布的修订。包或策略变化不改写快照。新尝试核对修订的后端 ID、程序和策略路径，不依赖最近检查结果；原绑定不可用时拒绝运行。没有 ID 的历史修订固定使用 `pi`，首次解析时记录其部署绑定。执行器停用后，读取运行快照返回冲突，公开历史仍可查。
