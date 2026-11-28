# 服务端接口契约

零依赖 Node 24 服务，默认监听 `0.0.0.0:8093`（`PI_WEB_PORT`），同时托管独立页面。工作台通过 `/api/pi/*` 访问，反代切掉模块前缀后就是这里的 `/api/*`。

所有响应是 `application/json; charset=utf-8` 或 `text/plain; charset=utf-8`，带 `Cache-Control: no-store`。错误信封统一为 `{ error: { code, message } }`；未命中的 `/api/*` 一律 404 JSON，不落静态兜底。

已登记 home 下的读写接口都不限制来源：服务部署在可信局域网，入口防护由前置层承担。

## 路由与 home 策略

每条路由声明 home 策略：`required`（走 realpath 校验）、`optional`（有则校验）、`none`（自己解析参数）。路由按域分组：`config/routes.ts`、`sessions/routes.ts`、`runtime/routes.ts`。`facts/` 是纯提取域，不带路由，它的唯一入口 `GET /api/sessions/:id/facts` 写在 `runtime/routes.ts`（实时投影需要运行时对象）。

### 健康检查与 home 域

| 方法与路径 | 策略 | 说明 |
| --- | --- | --- |
| `GET /api/health` | none | 状态、写策略、状态目录、home 数量；不触发 SDK 加载 |
| `GET /api/homes/defaults`、`/api/homes/check` | none | 默认位置、路径有效性 |
| `GET /api/homes/browse` | none | 本机目录浏览（选目录组件用）：query `path` 是位置 URI（`file:///abs`）或本机简写（裸路径、`~`），`~` 展开 + realpath，只列子目录，响应返回 URI；`ssh://` 返回 400 |
| `GET/POST/PATCH/DELETE /api/homes` | none | home 清单与增删改 |
| `GET /api/homes/:id` | none | home 实体（`sessionsRoot`、`capabilities`、`profileRevision`） |
| `GET /api/homes/:id/runtime-profile` | none | 运行时配置快照（模型候选、subagent、默认 cwd、目录采集时间） |

### config 域（文件级配置）

| 方法与路径 | 策略 | 说明 |
| --- | --- | --- |
| `/api/config/*` | required | settings / skills / agents / mcp / models / plugins |
| `GET /api/config/plugins/builtin` | required | 内置扩展清单（是否已安装、源文件是否可用、`heartbeatDetected` 总开关） |
| `POST /api/config/plugins/builtin/install` | required | 一键安装内置扩展到 home 的 extensions/（已安装则覆盖；`id` 必填） |
| `POST /api/config/plugins/builtin/uninstall` | required | 卸载内置扩展（清扫 .ts/.js/index 四种形态；幂等） |

### sessions 域（磁盘事实）

扫描、轨迹、删除、偏好、会话根。本域不 import runtime：续聊与起任务需要装配运行时，能力由组合根（`server.ts`）注入。

| 方法与路径 | 策略 | 说明 |
| --- | --- | --- |
| `GET /api/sessions` | none | 会话集合；`home=` 或 `root=` 定作用域，`since=` 做未变更快路径；每条实体带 `runtimes`（本进程 + 其它进程心跳，心跳合流由服务端 12 秒定时器驱动，读接口不触发），响应带 `heartbeatDetected`。`state=live` 只筛「本进程装配过」的实体，存活与否看 `runtimes` |
| `POST /api/sessions` | none | 建会话或起任务（`kind: chat \| task`）。新建传 `home` 与 `cwd`；续聊只传 `sessionId`，home 按实体归属取、会话文件取实体的 `filePath`，不接受 `sessionFile`。装配前先把实体迁到 `loading`（并发删改 409 `session_loading`） |
| `GET/PUT /api/sessions/prefs` | none | 项目特别关注 |
| `GET /api/sessions/roots?home=` | none | 该 home 的会话根 |
| `GET /api/sessions/:id` | none | 单个实体（状态、运行态、能力、模型、队列） |
| `GET /api/sessions/:id/trajectory` | none | 轨迹文本（canonicalize 后），支持 gzip；有本地运行时以运行时为准 |
| `DELETE /api/sessions/:id` | none | 删除会话文件与实体 |

### runtime 域（活会话运行时）

这些接口都作用在活的运行时上，URL 不变（从 `sessions/routes.ts` 迁到 `runtime/routes.ts`）。装配能力（新会话 / resume / 一次性任务）、turn、SSE、abort/模型切换/交互应答/evict 都在本域实现；装配的入口 `POST /api/sessions` 仍挂在 sessions 域（它要先按作用域解析出实体），由组合根 `server.ts` 调用本域。动作前一律先按 `:id` 取实体。

| 方法与路径 | 策略 | 说明 |
| --- | --- | --- |
| `GET /api/sessions/:id/events` | none | SSE：`transcript`、`state`、扩展 UI 请求与 SDK 事件；只对存在本地运行时的会话开放 |
| `POST /api/sessions/:id/turn` | none | 发一条消息，202 返回 `disposition`；`loading` 中 409 `session_loading` |
| `POST /api/sessions/:id/abort` | none | 先取消运行中的一次性任务，再中止对话并回传排队输入；两者都没有 409 `session_not_local` |
| `POST /api/sessions/:id/interaction` | none | 扩展 UI 回执（`interactionId` 必填） |
| `POST /api/sessions/:id/model` | none | 只切本会话模型与思考级别；`loading` 中 409 `session_loading` |
| `POST /api/sessions/:id/evict` | none | 释放运行时，保留文件 |

### facts 域（运行事实）

纯提取，没有自己的 `routes.ts`：`types.ts` 是契约，`replay.ts` 把会话文件重放成事实，实时投影在 `runtime/facts.ts`。

| 方法与路径 | 策略 | 说明 |
| --- | --- | --- |
| `GET /api/sessions/:id/facts` | none | 会话运行事实。有本地运行时返回实时投影（`source: runtime`），否则读会话文件重放（`source: file`） |

返回体就是 `facts/types.ts` 的 `SessionFacts`（前端 `web/src/views/chat/facts-api.ts` 同构）：

```json
{
  "source": "file",
  "model": {
    "initial": { "provider": "anthropic", "model": "claude-sonnet-4" },
    "current": { "provider": "openai", "model": "gpt-5" },
    "thinkingLevel": "high",
    "changes": [
      { "provider": "openai", "model": "gpt-5", "at": 1767607200000 }
    ]
  },
  "skills": {
    "listed": [{ "name": "codeindex", "location": "/home/me/.pi/agent/skills/codeindex/SKILL.md" }],
    "read": []
  },
  "mcp": {
    "servers": ["gitlab"],
    "note": "尽力推断：不含连接失败或未暴露工具的 server"
  },
  "tools": { "names": ["read", "bash"] },
  "promptSectionKeys": ["preamble", "tools", "skills", "mcp_servers", "cwd"],
  "recorded": true
}
```

`source: runtime` 时字段形状不变，只有 `model.current`、`model.thinkingLevel`、`tools.names` 由运行时覆盖。`null` 表示「会话文件里没记」；无头老文件 `recorded: false` 并带 `reason: "not_recorded"`。实体不存在 404 `session_absent`，既无本地运行时又无会话文件 409 `session_not_local`。

## 会话实体

```ts
{
  id, identitySource: 'minted' | 'header' | 'derived',
  origin: { kind: 'home', homeId, homePath } | { kind: 'external', rootPath },
  kind: 'chat' | 'task' | 'cli' | 'subagent',
  persistence: 'memory' | 'file', filePath, cwd, title, parentFile,
  disk: { size, mtime, format, messageCount, firstMessage, createdAt, updatedAt, projectKey, projectName, projectDir } | null,
  state: 'discovered' | 'loading' | 'ready' | 'running' | 'failed' | 'evicted',
  stateSince, error: { message, phase } | null,
  runtimes: [{ instanceId, origin: 'local' | 'process', host, pid, status, updatedAt }],
  model, queue, interactions, profileRevision,
  execution: { timeoutMs, outcome, outputLength, lastText } | null,
  capabilities: { canLoad, canTurn, canEvict, canDelete, canContinue, reason? },
}
```

集合响应带 `epoch` 与 `revision`：`since` 等于当前 revision 时返回 `notModified`；epoch 不同表示服务重启，调用方整份重取。

## 状态与错误码

| 情形 | 状态码与 code |
| --- | --- |
| 会话正在运行却要删改 | 409 `session_busy` |
| 会话正在装配 | 409 `session_loading` |
| 集合游标过期 | 200 `notModified: false` + 新 `epoch` |
| 会话文件已被外部删除 | 404 `session_absent` |
| 续聊的实体不能续聊（无头老文件、外部 CLI 会话等） | 409 `session_not_continuable` |
| 续聊的会话还没落盘 | 409 `session_not_persisted` |
| 轨迹超过体积上限 | 413 `session_too_large` |
| 该会话没有本地运行时 | 409 `session_not_local` |
| 同机另一个 pi 进程正在用这条会话，本服务只读（续聊装配） | 409 `runtime_elsewhere` |

## 环境变量

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `PI_WEB_HOST` / `PI_WEB_PORT` | `0.0.0.0` / `8093` | 监听地址 |
| `PI_WEB_STATE` | `$XDG_STATE_HOME/pi-web` | home 清单、索引、偏好、模型目录缓存 |
| `PI_WEB_STATIC_DIR` | `web/dist` | 独立页面产物 |
| `PI_WEB_MAX_CHATS` / `PI_WEB_CHAT_IDLE_MS` / `PI_WEB_CHAT_UI_TIMEOUT_MS` | 8 / 1800000 / 120000 | 对话上限、空闲回收、扩展 UI 兜底超时 |
| `PI_WEB_MAX_TASKS` / `PI_WEB_TASK_TIMEOUT_MS` | 4 / 600000 | 一次性任务上限与超时 |
| `PI_WEB_MAX_FILES` / `PI_WEB_MAX_TEXT_BYTES` | 5000 / 67108864 | 扫描文件数上限、轨迹体积上限 |
| `PI_WEB_EXTERNAL_ROOTS` / `PI_WEB_EXTERNAL_ROOT_TTL_MS` | 4 / 1800000 | 外部目录 LRU 与空闲回收 |
