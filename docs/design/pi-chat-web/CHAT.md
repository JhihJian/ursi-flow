---
parent: ../..
references:
  - ../../../apps/pi-manager-web/SPEC.md
  - ../../../apps/pi-sessions-web/SPEC.md
  - ../../../packages/workspace-shell/MODULE-CONTRACT.md
---

# Pi 交互对话

## 功能意图

拆分之后，上游 Pi Web 剩下的唯一核心能力是交互式对话：多轮、流式、工具调用可见、可打断、可续聊。管理台只有"跑一轮就结束"的一次性任务，会话浏览只有只读渲染。

本模块补上这块，并明确它依赖 pi-manager-web：

- **运行时归管理台**。会话要真实加载某个 pi home 的模型、凭据、skills、subagent 与 MCP，还要受并发、超时、限流约束——这些都是管理台已经拥有的（`sdk.ts`、`session-task.ts`、home 清单、模型目录、agent 定义）。
- **界面是独立模块** `@ursi/pi-chat-web`。编译期依赖管理台公开客户端 `@ursi/pi-manager-web/client`，运行期依赖管理台服务；不 import 管理台的组件与 store，也不读写配置文件。
- **一场对话绑定一个 pi home**。选 home 就是选整套配置：模型清单与默认模型、凭据、skills、agents、MCP、工具策略。会话文件仍写进该 home 的 `sessions/`，pi CLI 能接着聊，会话浏览模块能看到完整轨迹。

边界（不做）：

- 不做配置编辑（管理台的活），不改 `settings.json`；会话内换模型只影响当前会话。
- 不做历史会话扫描与轨迹浏览（会话模块的活）。本模块侧栏只列自己打开的对话。
- 不做终端、文件浏览、git、worktrees、推送、附件与图片输入。
- 不做多用户共享会话、不做鉴权（沿用管理台的可信局域网边界）。
- 不复用上游 Pi Web 的对话组件：它属于 Next + Tailwind 的代码，拆不出来。

## 依赖与契约

```
pi-chat-web ──编译期──▶ @ursi/pi-manager-web/client（纯 TS 客户端与类型，无 React、无 store）
            ──运行期──▶ 管理台服务 /api/chat/*（SDK、home、凭据、限流都在这里）
            ──组合根注入──▶ pi-sessions 的 openSession 命令（跳完整轨迹）
pi-sessions ──组合根注入──▶ pi-chat 的 resumeSession 命令（在对话里继续某条历史会话）
```

- 组合根只传普通值与函数：`managerApiBaseUrl`、`storageKey`、`openSessionInSessions`、`resumeSessionInChat`。
- `managerApiBaseUrl` 只能是同源路径前缀（默认 `/api/pi-manager`）。管理台不返回 CORS 头，`EventSource` 也无法带自定义请求头，跨源形态不支持。
- 管理台新增公开客户端导出 `"./client"`（`web/package.json` 增加 `exports`，同时保留现有入口可达）。它把 home、模型目录、agent 清单、会话根、任务、对话的接口与类型收在一处；前端所有调用都走它，不散写 fetch。
- 依赖方向单向：chat 依赖 manager；sessions 谁都不依赖，只接收注入的命令。

## 服务端：管理台新增会话运行时

### 为什么放在管理台

对话需要的每件东西管理台都已经有：SDK 按需加载、home 校验与 `realpath`、模型目录采集、agent 解析、并发与超时控制、`sessions/` 写入规则。另起一个进程意味着全部重写一遍，还会出现两套凭据读取与两套 home 校验。

代价要写清（这条才是真正的取舍账）：一场对话常驻会持有 `ResourceLoader`（可能加载该 home 的扩展、spawn MCP server 子进程）、`ModelRuntime`（含 OAuth 刷新）与一个 AgentSession。默认上限 8 场，意味着最多 8 份这类资源。管理台 SPEC 里「除一次性会话任务外不加载扩展、不驶驻会话」的边界因此改写成「除一次性任务与对话运行时外，配置管理路径不加载扩展、不驻留会话」。管理台现有接口里 `models-probe` 会发外网请求、`models-runtime` 会加载扩展，因此"配置页全是同步文件读写"的说法本来也不成立：隔离手段是限流与空闲回收，不是事件循环假设。

### 抽 `session-runtime.ts`

把 `session-task.ts` 里装配 AgentSession 的逻辑抽出来共用：

- 输入：`home`、`cwd`、`model`、`thinkingLevel`、`subagent`、可选 `sessionFile`（续聊）。
- 校验：home 已登记或已发现且有效；`cwd` 存在且是目录（沿用 `resolveCwd`）；`model` 写成 `provider/modelId` 且能在该 home 的运行时目录里找到；`thinkingLevel` 合法；`subagent` 存在（复用 `resolveSubagent`）。
- 装配：先 `createAgentSessionServices({ cwd, agentDir: home })`，它把该 home 的 settings、modelRuntime 与 resourceLoader 一起建好，并把扩展注册的 provider 注册进 modelRuntime。然后按合并后的 settings 解释 `enabledModels`（`resolveModelScopeWithDiagnostics`，支持 glob、模糊匹配与 `:thinkingLevel` 后缀），用 `selectInitialModelScope` 同一份规则决定初始模型与思考级别：settings 默认值在范围内才生效，否则用范围首项，再退到首个可用模型；`:level` 钉住值优先于单模型设置与全局默认。显式 `model` 允许越出范围（等同 pi 的 `--model`）。最后 `createAgentSession`，把 `scopedModels` 一并交给会话，Ctrl+P 循环与选择器保持一致；续聊传 `SessionManager.open(path)` 并沿用文件里的模型与档位。
- 释放：统一走一个 `disposeSession()`。优选用 SDK 的 `createAgentSessionRuntime`（它的 `dispose()` 依次做 abort → `session_shutdown` → `session.dispose()` → `modelRuntime.settleCredentialWrites()`），一次性任务也切过去，避免两套释放语义；若 runtime 装配成本过高，则内部复刻这三步并用测试断言 `session_shutdown` 被触发。直接调 `session.dispose()` 会不发 `session_shutdown`，心跳扩展删不掉 `state/running-sessions/<id>.json`，会话模块与管理台面板都会看到幽灵 running，OAuth 刷新期间的 token 也可能丢。顺带修掉 `resolveModel` 现有 `as never` 的返回类型。
- 任务与对话共用 `live` 表，一个 `sessionId` 只允许一个运行时。

### 接口

| 接口 | 说明 |
| --- | --- |
| `GET /api/chat/options?home=` | 对话可选项：模型候选**只含 `enabledModels` 范围内的模型**（解析交给 pi 的 `resolveModelScopeWithDiagnostics`，空清单或解析不到时回退全部可用），每个模型带 provider 显示名、显示名、`thinkingLevels`（`getSupportedThinkingLevels` 口径）与档位映射；默认模型与默认思考级别按 pi 的启动规则算；另有 agent / subagent 清单、服务端实际会用的默认 cwd、会话根与目录采集时间。目录未采集时只回默认值并标 `catalogFetchedAt: null` |
| `POST /api/chat/session` | 建会话：`{ home, cwd?, model?, thinkingLevel?, subagent?, sessionFile? }` → `{ sessionId, sessionFile, home, cwd, model, thinkingLevel, fallbackMessage? }`。响应里的 `model` / `thinkingLevel` 是服务端实际生效值（含模型回退原因），前端以此为准，不回显请求参数 |
| `POST /api/chat/prompt` | `{ sessionId, text, mode? }` → `202 { disposition: 'started' \| 'queued' \| 'handled' }`。只等 SDK 的受理预检，不等整轮跑完；`mode` 为 `followUp`（默认）或 `steer`。空文本 400 |
| `POST /api/chat/abort` | `{ sessionId }` 先取消挂起的扩展对话框（会话级 stop 信号），再清队列并中止，把排队输入原样返回给前端 |
| `POST /api/chat/model` | `{ sessionId, provider, modelId?, thinkingLevel? }` 只切本会话，不写 `settings.json` |
| `POST /api/chat/answer` | `{ sessionId, requestId, value }` 回执扩展 UI 请求 |
| `GET /api/chat/stream?sessionId=` | SSE。首帧 `{ type: 'transcript', jsonl }`（当前会话的完整行文本，形状与 pi 会话文件一致），第二帧 `{ type: 'state', isStreaming, partial, partialThinking, pendingCount, model, thinkingLevel, ... }`，随后重发仍然挂着的 `extension_ui_request`，再转发事件 |
| `GET /api/chat/session?sessionId=` | 状态快照：`isStreaming`、`partial`（当前流式中的助手文本）、`pendingCount`、模型与思考级别、上下文用量、最后一条错误、`sessionFile` |
| `GET /api/chat/sessions?home=` | 本进程里存活的对话（服务端快照，浏览器不另存一份列表） |
| `POST /api/chat/close` | `{ sessionId }` 结束并释放；回收与进程退出复用同一个内部 `disposeChat()` |

事件帧直接对应 SDK 的 `AgentSessionEvent`，不做自创命名：

- `agent_start`、`turn_start`、`turn_end`
- `message_start`（带 `role`）、`message_update`（`assistantMessageEvent` 剥掉每帧都携带的完整 `partial`）、`message_end`
- `tool_execution_start`、`tool_execution_update`、`tool_execution_end`（平铺转发，带 `toolCallId` / `toolName` / `durationMs`）
- `entry_appended`、`queue_update`、`thinking_level_changed`、`agent_settled`
- `compaction_start` / `compaction_end`、`auto_retry_start` / `auto_retry_end`、`bash_execution_update`
- 文本增量 `delta` 与思考增量 `thinking_delta` 按 ~50ms 合并一帧；每 15 秒一个 `heartbeat` 数据帧，让浏览器能判半开连接

扩展 UI 请求与错误是 chat 自有帧（`extension_ui_request`、`error`），不是 `AgentSessionEvent` 的一部分。SDK 的 RPC 模式（`runRpcMode` / `rpc-types`）已经定义过一套同构协议（`prompt/steer/follow_up/abort/get_state/set_model/extension_ui_request`），本设计**复用它的语义但不复用实现**：RPC 模式是独立子进程 + stdio，我们要的是同进程 + HTTP。帧名保持与 SDK 一致，避免自造词汇。

### 关键决定

- **SSE 而不是 WebSocket**：事件单向，发送用普通 POST；断线按 `sessionId` 重连并回放 transcript 与当前 partial。
- **回放用会话行文本**：`transcript` 给会话文件形状的 JSONL，浏览器用同一个 `parsePiJsonl` 解析。对话模块与会话模块因此共用一份转换与渲染，不出现第二个转换器。
- **流式增量单独一条**：模型输出阶段还没有落盘 entry，前端把它渲染成时间线末尾的"进行中"消息；`entry_appended` 到达后用权威文本替换。不在每个 token 上重解析整份 transcript，增量按 ~50ms 合并一帧。
- **断线不丢流**：`GET /api/chat/session` 与 SSE 第二帧都带 `partial`、`partialThinking` 与 `isStreaming`，因此流式中断开、重连后能立刻补回当前这段文本与思考。
- **模型权威**：服务端按 `enabledModels` 算范围，默认模型只在范围内生效，显式指定允许越界（等同 pi 的 `--model`）；前端不重写匹配规则，也不把未启用模型放进候选。
- **扩展 UI 桥接**：`ExtensionUIContext` 有二十多个成员，`confirm` / `select` / `input` / `notify` 转成帧等待 `/api/chat/answer`；TUI 专属能力（`onTerminalInput`、`setWidget`、`setFooter`、`custom`、`editor` 等）做成 headless stub：降级为 `notify` 或静默丢弃。服务端对每个 UI 请求设置兜底超时（默认 120 秒，扩展给了正的有限值时取较小值），超时回默认值并广播 `extension_ui_closed`；中止会话时先 abort 会话级 stop 信号，等确认的扩展不会把 Esc 拖到超时。重连时首帧之后重发仍然挂着的请求，刷新页面不丢确认框。工具审批策略沿用该 home 的设置与已装扩展，管理台不另造一套。
- **续聊的参数优先级**：续聊只接受 `sessionFile`，不接受 `cwd` 与 `subagent`（transcript 里已经记录了当时的 cwd、系统提示与工具集，重新追加 subagent 正文会重复系统提示、覆盖工具集）。`sessionFile` 必须 `realpath` 后落在某个已登记 / 已发现 home 的 `sessions/` 下，否则 400：`SessionManager.open` 对不存在的路径会直接新建文件，不校验会让调用方借服务端在任意路径写 JSONL、并让工具在 header 记录的任意目录执行。
- **受理即返回**：`POST /api/chat/prompt` 用 SDK 的 `preflightResult` 拿到 `started` / `queued` / `handled` 就回 202，运行期错误走 SSE 的 `error` 帧。等 `prompt()` 整个回合会让长回合把 HTTP 请求挂住几分钟，前端也分不清提交失败与运行中出错。
- **一个 `sessionId` 只有一个运行时**：同一会话文件不允许两个运行时并行追加；重复创建时丢掉新装配的会话，直接接到已有对话上。
- **限流与生命周期**：`PI_MANAGER_MAX_CHATS`（默认 8）超出返回 429；空闲 30 分钟自动 `disposeChat()` 并保留会话文件；进程退出统一走同一函数。浏览器只记最近打开的 `sessionId` 与 `sessionFile`，刷新先按 `sessionId` 接回，接不上则提示按 `sessionFile` 续聊。
- **只在服务端持有凭据**：与现有接口一致，凭据不出服务端，SSE 帧里不出现密钥与 header。
- **路由层要能接管响应**：现有 `api.ts` 的 handler 只能 `return` 值，最后由 `sendJson(res, 200, result)` 统一写响应，没有接管 `res` 的通道；`/api/chat/` 也要加进 `selfResolved`（否则会走 `resolveRequestedHome('')` 直接抛错）。SSE 与 202 需要显式扩展这一层，并在反代上关掉对 `text/event-stream` 的缓冲与压缩。

## 前端模块：`@ursi/pi-chat-web`

包形态与 `apps/pi-sessions-web` 一致：导出 `./module` 与 `./module.css`，自带 Vite 独立入口，无服务端。

### 侧栏

- **pi home 选择器**：数据来自管理台公开客户端（`listHomes`），与管理台模块用同一份清单，不另存 home 注册表。切换 home 后模型、思考级别、工作目录与 subagent 选项刷新，对话列表按当前 home 过滤；没有可用 home 时提示去管理台新增并 `shell.reveal('pi-config')`。
- **新对话的落点**：工作目录与 subagent 在侧栏；模型与思考级别在输入区的工具条上，跟上游 Pi Web 的 composer 一致。
- **对话列表**：服务端 `GET /api/chat/sessions?home=` 的快照，显示状态、模型、思考级别与最近活动；「结束当前对话」释放运行时。
- 折叠态显示运行中数量与当前 home，符合外壳窄条约定。

### 工作区

- 新对话与已有对话共用一块工作区：没有选中对话时是编辑器（空轨迹 + 输入区），发出第一条消息才建会话；选中后是同一份布局叠加轨迹。
- 时间线：`pi-agent-trajectory-viewer` 渲染已落盘部分（`transcript` + `parsePiJsonl`），末尾单独渲染流式文本、思考、正在执行的工具与排队数；`message_end` / `agent_settled` 后由权威 transcript 替换。
- 输入区工具条：模型（按 provider 分组的候选，只含启用范围）、思考级别（按模型过滤，显示供应商映射）、发送 / 停止；运行中 Enter 排队，另有「立即插话」。
- 顶部一行：对话名、工作目录、运行状态、停止 / 新对话 / 结束。
- 扩展 UI 请求渲染成会话内的确认条或选择面板，不用 `alert` / `confirm`；请求带过期时间，服务端关闭时同步移除。
- 断线显示可重连提示，重连后从状态快照与回放补回当前输出；服务端已经释放的对话会被识别并收尾。
- 自动重试与上下文压缩是独立提示条，不把界面做成“卡死”。

### 界面样式

- **跟看板同一套版面**：灰阶（`#1a1a1a` / `#666` / `#999` / `#e5e5e5`）、衬线小标题、等宽正文、方角、选中靠左侧竖线，与 `apps/todo-web` 和 `apps/pi-sessions-web` 一致；侧栏分组标题用衬线大写眉毛，列表项是一行名称加一行等宽次信息。
- **样式作用域**：所有规则挂在 `.pichat` 容器下，侧栏与工作区各包一层，不写 `html` / `body` / `:root`；独立入口的页面复位只放在 `standalone.css`。
- **轨迹组件库配色**：把上游的 `dsw-alias-*` 与时间线色映射到本模块的灰阶，与会话模块那份映射一致，改动时两边同步。
- **独立入口**：固定两栏（侧栏 300px + 工作区），不引入可拖拽分栏，折叠由外壳负责，页面里不出折叠控件。开发端口 5193（5192 被 fs-web 的 dev server 占用）。

### 选中与命令

- 发布 `context.kind = 'pi.chat'`，选中值只有 `{ kind, id, label }`，实体由模块按 `sessionId` 自取。
- 命令 `resumeSession({ sessionFile })`：在对话里继续一条历史会话。home 由管理台按会话文件路径反查（它已有 home 清单与 `sessions/` 布局规则），调用方不推导。
- 动作「在会话模块打开完整轨迹」：`openSession({ root, sessionFile, id })` 后 `shell.reveal('pi-sessions')`；会话模块未启用时用 `shell.enabled('pi-sessions')` 给禁用原因。`root` 取管理台的 `GET /api/session/disk?home=`（`{ root, exists }`），前端不拼路径。

## 聚合后的工作台

```
shell-web（组合根）
├─ pi-chat     ──/api/pi-manager/chat/*──▶ 管理台服务（会话运行时）
├─ pi-config   ──/api/pi-manager/*───────▶ 管理台服务（配置与 home）
├─ pi-sessions ─/api/pi-sessions/*───────▶ 会话服务（扫描与轨迹）
└─ 既有模块（fs / ssh / todo / flow …）
```

新增接线：

| 边 | 形式 |
| --- | --- |
| 组合根 → pi-chat | `managerApiBaseUrl`、`openSessionInSessions: sessions.commands.openSession` |
| 组合根 → pi-sessions | `resumeSessionInChat: chat.commands.resumeSession`（`pi.session` 的「在对话里继续」动作） |

profile：`{ id: 'pi', title: 'Pi 控制台', modules: ['pi-chat', 'pi-config', 'pi-sessions', 'fs-web'] }`；另有 `{ id: 'pi-chat', title: '对话', modules: ['pi-chat'] }`。

闭环：会话模块里挑一条历史会话 →「在对话里继续」→ chat 建运行时接管；聊完 →「在会话模块打开完整轨迹」→ 回到会话模块看同一份文件。两边用的是同一个 `sessionFile`，中间没有数据搬迁。

## 关键取舍

- **运行时放管理台 vs 独立进程**：独立进程能隔离故障域，但要重做 home 校验、凭据读取、模型目录、agent 解析与限流，还要再引一份 SDK。选放管理台，用限流与空闲回收控制资源占用；资源账见上文（每场对话一份 ResourceLoader / ModelRuntime / MCP 子进程）。
- **对话界面独立模块 vs 塞进会话模块**：塞进去会让只读模块持有事件流与输入状态，与它"唯一写操作是删除"的边界冲突。独立模块只共享渲染库，不共享状态。
- **复用 `parsePiJsonl` vs 另写增量解析**：复用。流式阶段只维护一条进行中消息，落盘后以权威文本为准。
- **pi RPC 模式子进程**：能拿到完整 JSON-RPC 事件与扩展 UI 通道，隔离更好，但多一层进程与状态同步。先不做；帧语义借用它的词汇，实现走同进程。

## 落地顺序与验证

前置（chat 依赖但当前不存在，必须先做）：

0. `pi-config` 模块化并接入工作台、`/api/pi-manager` 代理（在通用 `/api` 之前，SSE 不缓冲）、`workspace-shell` 侧 `openSession` 命令与 `resumeSessionInChat` 注入点、`GET /api/session/disk`。没有这一步，chat 的跳转与续聊没有落点。

1. **`session-runtime.ts` 抽取**：装配、校验、`disposeSession()`、`live` 表合并；一次性任务切到新装配与释放路径。验证：`node --test src/*.test.ts` 全绿，并断言 `session_shutdown` 被触发。
2. **路由层扩展**：handler 可接管 `res`（SSE / 202），`/api/chat/` 进 `selfResolved`。验证：SSE 首帧回放、非 SSE 路由仍走 `sendJson`。
3. **chat 接口**：会话 CRUD、SSE、prompt（含 `mode`）、abort + 队列返回、model、answer、options、限流与空闲回收、`sessionFile` 归属校验、单运行时约束。验证：并发上限 429、越界 `sessionFile` 400、重复打开 409、流式中断线重连补回 partial。
4. **公开客户端**：`web/package.json` 增 `exports`，client 改为接受 `baseUrl` 的工厂，现有页面切换过去。验证：独立站点与工作台两个入口共用同一份客户端。
5. **chat 模块**：侧栏 home / 模型 / cwd / subagent、时间线与流式尾行、输入与停止、扩展 UI 弹窗、断线重连、`pi.chat` 选中与两个动作。
6. **组合根接线与 profile**：两条命令、两个 profile、Registry 页展示。
7. **文档同步**（见下）。
8. 手测清单分两段：
   - 只依赖已存在能力：选 home 后模型清单来自该 home；缺凭据时明确报错（不会静默借用别的 home 的凭据）；流式期间能看到工具调用与排队；停止后会话仍空闲可继续发。
   - 依赖本设计新增能力：聊完在会话模块看到该会话；从会话模块续聊接上历史；并发超限提示；管理台重启后按 `sessionFile` 续聊；越界 `sessionFile` 被拒。

## 文档改动

- 新增 `apps/pi-chat-web/SPEC.md`：功能意图、home 绑定、消费的对话接口、渲染复用、边界与验收。
- `apps/pi-manager-web/SPEC.md`：新增「对话运行时」一节（接口、`session-runtime` 抽取与 `disposeSession`、限流与回收、扩展 UI 桥接、公开客户端导出、路由层接管响应），改写"不加载扩展、不驻留会话"的边界表述，模块结构登记新文件。
- `apps/pi-sessions-web/SPEC.md`：新增接收 `resumeSessionInChat` 的「在对话里继续」动作。
- `apps/pi-sessions-web/server/HTTP.md`：说明对话运行时不在本服务内。
- `SPEC.md` / `ARCHITECHTURE.md`：模块职责与模块关系补「Pi 交互对话依赖管理台的运行时与 home 配置；对话、配置、会话三者通过工作台组合，各自可独立部署」，设计索引已登记本文件，并同步 `SPLIT-AND-AGGREGATION.md` 的对话位置一节。

## 实现注记（落地时与原设计的差异）

- **释放不依赖 `session_shutdown`**：SDK 的 `AgentSession.dispose()` 不发这个事件，而 `emitSessionShutdownEvent` 没有从包根导出。`disposeSession()` 因此自己按 abort → dispose → `settleCredentialWrites()` → 删除本进程心跳文件的顺序收尾，避免会话在会话模块里以「运行中」挂到 60 秒超时。
- **装配先建 services**：`createAgentSessionServices()` 才会把扩展注册的 provider 注册进 modelRuntime；先建 services 再解析范围与初始模型，扩展提供的模型才能被选中，`enabledModels` 的 glob 与 `:level` 也才能真正生效。
- **初始模型由调用方选**：SDK 的 `createAgentSession` 在未传 `model` 时固定用 `scopedModels: []` 调 `findInitialModel`，范围的顺序与钉住值会失效；因此 `assembleSession` 先按 `selectInitialModelScope` 的同一份规则算出 model 与 thinkingLevel 再传进去，同时把 `scopedModels` 交给会话供循环使用。
- **transcript 靠整体重发**：实测 `entry_appended` 不触发，消息落盘后由服务端重建整段行文本并重发 `transcript` 帧。浏览器始终用 `parsePiJsonl` 解析，与回放走同一条路径。
- **「在会话模块打开完整轨迹」是 `actions` 而不是工作区按钮**：工作区拿不到 `ShellHandle`，只有 actions 的 `run` 能 `shell.reveal`，因此跳转入口放在右侧控制面板。
- **重复打开同一会话直接接到已有对话**：同一份 JSONL 不允许两个运行时并行追加；新装配的会话被释放，返回已有对话。
- **thinking level 补上 `high`**：原 `session-task` 的档位列表漏了 `high`，会让默认级别为 high 的 home 直接报 400；现在任务与对话共用 `agents.ts` 的那份定义。
- **目录缓存补充能力字段**：`RuntimeCatalog` 的每个模型记录 `thinkingLevels` 与 `thinkingLevelMap`，目录带 provider 显示名；老缓存缺字段时按 `reasoning` 退回基础档位，不影响读取。
- **前端从「先建空对话」改为「首条消息建对话」**：上游 Pi Web 的 `ensure_session` + `prompt` 顺序被压成一次「建会话 → 立刻发首条消息」，失败时把文本放回输入框。
- **刷新接回**：浏览器只记最近一条 `{ sessionId, sessionFile, home }`；`sessionId` 接不上时按 `sessionFile` 让管理台重新装配。事件流在服务端释放后不会重连成功，前端确认 404 后收尾并提示。
