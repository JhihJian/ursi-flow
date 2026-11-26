---
parent: ../../SPEC.md
references:
  - ../pi-manager-web/SPEC.md
  - ../pi-sessions-web/SPEC.md
  - ../../packages/workspace-shell/MODULE-CONTRACT.md
  - ../../docs/design/pi-chat-web/CHAT.md
---

# Pi 交互对话

## 功能意图

在浏览器里与 pi agent 多轮对话：流式输出、工具调用可见、可打断、可续聊。运行时归 [Pi 管理台](../pi-manager-web/SPEC.md)（它持有 pi SDK、pi home 校验、凭据、模型目录与并发控制），本模块只做界面，通过管理台公开的客户端 `@ursi/pi-manager-web/client` 使用其接口。

一场对话绑定一个 pi home：选 home 就是选整套配置（模型清单与默认模型、凭据、skills、agents、MCP、工具策略）。会话文件写进该 home 的 `sessions/`，pi CLI 能接着聊，[Pi 会话浏览](../pi-sessions-web/SPEC.md) 能看到完整轨迹。

建立对话的顺序对齐上游 Pi Web：先在工作区的输入区选好模型与思考级别，发出第一条消息时才向管理台建会话，建完立刻接上事件流。没有「新建空对话」这个动作，因此不会留下没有消息的会话文件。

边界：不做配置编辑、不做历史会话扫描与轨迹浏览、不做终端与文件浏览、不做多用户共享会话与鉴权。不复用上游 Pi Web 的对话组件（Next + Tailwind 代码，拆不出来）。

## 关键功能与验收

### 选择 pi home 与对话参数

#### 验收

- 侧栏顶部是 pi home 选择器，数据来自管理台的 home 清单，与管理台模块用同一份注册表；切换 home 后模型、思考级别、工作目录与 subagent 选项随之刷新，本模块打开的对话列表按当前 home 过滤。
- 模型候选**只含该 home 的 `enabledModels` 范围内**的模型：`enabledModels` 支持 glob、模糊匹配与 `:thinkingLevel` 后缀，解析不到时回退全部可用，判定交给 pi 自己的解析器，不在前端重写匹配规则。模型按 provider 分组，组名用 provider 显示名，条目显示名与 id 同时给出。
- 思考级别按模型给：只列该模型支持的档位，供应商真实值有映射时一并显示（如 `high → xhigh`）。换模型时档位落到新模型支持的值上，优先用 `:level` 钉住值，再退到全局默认。
- 工作目录默认显示服务端会用的目录；留空即用服务端默认。subagent 取该 home 的 `agents/*.md` 名字，留空是普通主会话。
- 模型目录未采集时仍可用默认模型，界面说明去管理台刷新目录才能选择具体模型；此时不编造候选。
- 没有可用 home 时说明原因，不显示半截表单。

### 建立一场对话

#### 验收

- 工作区在「新对话」状态下只显示输入区与参数；按下发送（或 Enter）时才 `POST /api/chat/session` 建会话，成功立刻 `POST /api/chat/prompt` 发首条消息，并把该对话设为当前。
- 建会话或发消息失败时把文本原样放回输入框并显示服务端错误；不静默丢字，也不留下空对话。
- 建会话回包里的 `model`、`thinkingLevel` 是服务端实际生效值（含模型回退说明），界面以此为准。

### 对话收发与流式

#### 验收

- 发送走 `POST /api/chat/prompt`：Enter 发送、Shift+Enter 换行、Esc 中止；运行中再提交按 `followUp` 排队，也可显式选「立即插话」（`steer`），界面显示排队数。
- 中止后把排队中的消息原样放回输入框，并在已有文本前插入，不静默丢弃。
- 事件流用 SSE：首帧回放会话行文本，用 `parsePiJsonl` 解析后交给 `pi-agent-trajectory-viewer` 渲染；第二帧是状态快照，补齐流式中的文本与思考；随后重发仍挂着的扩展 UI 请求再转发增量。
- 流式中的文本、思考与正在执行的工具单独渲染在末尾；落盘后由权威 transcript 替换。断线后浏览器自动重连，重连时从快照与回放里补回当前这段输出；服务端已经释放的对话会被识别并收尾。
- 自动重试与上下文压缩有独立提示条，界面不会在重试或压缩期间看起来像卡住。
- 扩展 UI 请求（确认 / 选择 / 输入 / 通知）渲染成会话内的确认条或选择面板，不使用 `alert` / `confirm`；请求带过期时间，服务端超时或取消后界面同步移除。

### 会话内换模型与思考级别

#### 验收

- 换模型与思考级别只影响本会话，不写 `settings.json`；回包是服务端实际生效值，界面以此更新。
- 流式期间禁用模型切换，思考级别仍可切（SDK 每次请求前重读）；新对话的档位跟着所选模型走。
- 当前会话的模型不在候选范围（续聊、范围收窄、显式越界）时仍然显示真值，并标「不在候选范围」，不假装它被启用。

### 刷新后接回

#### 验收

- 浏览器记住最近打开的对话（`sessionId` 与 `sessionFile`）；刷新后先按 `sessionId` 接回，服务端已重启或已释放时按 `sessionFile` 让管理台重新装配，接不上则提示，不影响开新对话。
- 会话列表来自服务端进程内快照，按当前 home 过滤；轮询不会把刚建好、还没进入某次旧响应的对话冲掉。

### 与另两个模块的协作

#### 验收

- 发布 `context.kind = 'pi.chat'`，选中只带 `{ kind, id, label }`；状态栏显示 home、模型与运行状态。
- 注入 `openSessionInSessions` 时提供动作「在会话模块打开完整轨迹」：先取该 home 的会话根，再 `shell.reveal('pi-sessions')`；会话模块未启用或对话还没有会话文件时给出禁用原因。
- 命令 `resumeSession({ sessionFile })`：在对话里继续一条历史会话，home 由管理台按会话文件反查；返回会话 id 与标题，失败抛错。
- 工作区拿不到外壳句柄，因此跳转一律走 `actions`，不在工作区里自造跳转按钮。

### 接入工作区外壳

#### 验收

- `createPiChatModule({ managerApiBaseUrl, storageKey, openSessionInSessions?, onNotice? })` 返回 `WorkspaceModule & { commands }`；`managerApiBaseUrl` 只能是同源路径前缀。
- 侧栏用平台的 `SidebarFrame`：展开态是 home 选择、新对话的工作目录与 subagent、本模块打开的对话列表；折叠态一条窄条显示运行中数量与当前 home。
- 工作区只放对话：顶部一行状态与操作，中间轨迹、流式块与工具状态，底部输入区；模型与思考级别在输入区的工具条上，跟上游 Pi Web 的 composer 一致；不含模块标题。
- 版面与灰阶沿用 `apps/todo-web`：衬线小标题、等宽正文、方角、选中靠左侧竖线；轨迹组件库的配色映射与会话模块同一份。
- 重型依赖（轨迹组件库）由工作区 `lazy` 加载，侧栏与首屏不背它；`localStorage` 键以 `storageKey` 为前缀。
- 独立入口与嵌入模式共用同一对组件与同一份状态；独立入口的接口前缀默认同源，开发时由代理转发到管理台（开发端口 5193）。

## 模块结构

- `web/src/module.tsx`：模块工厂、选中同步、状态栏、跳转动作与 `resumeSession` 命令。
- `web/src/chat-context.tsx`：home、对话参数草稿、对话列表、建会话与首条消息、SSE 连接、流式文本/思考/工具、扩展 UI 请求、刷新后接回与错误状态。
- `web/src/components/ChatSidebar.tsx`：home 选择、新对话的工作目录与 subagent、对话列表。
- `web/src/components/ChatWorkspace.tsx`：轨迹渲染、流式块与工具状态、模型与思考级别工具条、扩展 UI 提示与输入区。
- `web/src/main.tsx` 与 `index.html`：独立入口；`module.css` 是 `./module.css` 导出给宿主的样式，`standalone.css` 只服务独立入口的两栏版面。
