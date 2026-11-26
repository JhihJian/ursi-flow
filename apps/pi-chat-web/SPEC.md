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

一场对话绑定一个 pi home：选 home 就是选整套配置（模型清单与默认模型、凭据、skills、agents、MCP、工具策略）。会话文件写进该 home 的 `sessions/`，pi CLI 与 pi-web 能接着聊，[Pi 会话浏览](../pi-sessions-web/SPEC.md) 能看到完整轨迹。

边界：不做配置编辑、不做历史会话扫描与轨迹浏览、不做终端与文件浏览、不做多用户共享会话与鉴权。不复用 pi-web 的对话组件（Next + Tailwind 的上游代码，拆不出来）。

## 关键功能与验收

### 选择 pi home 与对话参数

#### 验收

- 侧栏顶部是 pi home 选择器，数据来自管理台的 home 清单，与管理台模块用同一份注册表；切换 home 后模型、思考级别、工作目录与 subagent 选项随之刷新。
- 新建对话前可设：模型（默认为该 home 的默认模型，候选按 `enabledModels` 标注是否启用）、思考级别、工作目录（留空用服务端默认，界面显示服务端会给的值）、subagent（`agents/*.md` 的名字，留空是普通主会话）。
- 模型目录未采集时仍可用默认模型，界面说明去管理台刷新目录才能选择具体模型。
- 没有可用 home 时说明原因，不显示半截表单。

### 对话收发与流式

#### 验收

- 发送走 `POST /api/chat/prompt`：Enter 发送、Shift+Enter 换行、Esc 中止；运行中再提交按 `followUp` 排队，也可显式选「立即插话」（`steer`），界面显示排队数。
- 事件流用 SSE：首帧回放会话行文本，用 `parsePiJsonl` 解析后交给 `pi-agent-trajectory-viewer` 渲染；流式中的文本单独渲染成末尾的「正在输出」块，落盘后由权威 transcript 替换。
- 断线后重新连接并重新回放；`isStreaming` 与当前 partial 随状态快照返回，因此流式中断开再回来能看到这段文本。
- 中止后把排队中的消息原样放回输入框，不静默丢弃。
- 扩展 UI 请求（确认 / 选择 / 输入 / 通知）渲染成会话内的确认条或选择面板，不使用 `alert` / `confirm`；超时由服务端兜底。

### 与另两个模块的协作

#### 验收

- 发布 `context.kind = 'pi.chat'`，选中只带 `{ kind, id, label }`；状态栏显示 home、模型与运行状态。
- 注入 `openSessionInSessions` 时提供动作「在会话模块打开完整轨迹」：先取该 home 的会话根，再 `shell.reveal('pi-sessions')`；会话模块未启用或对话还没有会话文件时给出禁用原因。
- 命令 `resumeSession({ sessionFile })`：在对话里继续一条历史会话，home 由管理台按会话文件反查；返回会话 id 与标题，失败抛错。
- 工作区拿不到外壳句柄，因此跳转一律走 `actions`，不在工作区里自造跳转按钮。

### 接入工作区外壳

#### 验收

- `createPiChatModule({ managerApiBaseUrl, storageKey, openSessionInSessions?, onNotice? })` 返回 `WorkspaceModule & { commands }`；`managerApiBaseUrl` 只能是同源路径前缀。
- 侧栏用平台的 `SidebarFrame`：展开态是 home 选择、新建对话参数、本模块打开的对话列表；折叠态一条窄条显示运行中数量与当前 home。
- 工作区只放对话：顶部一行状态与操作，中间轨迹与流式块，底部输入区；不含模块标题。
- 版面与灰阶沿用 `apps/todo-web`：衬线小标题、等宽正文、方角、选中靠左侧竖线；轨迹组件库的配色映射与会话模块同一份。
- 重型依赖（轨迹组件库）由工作区 `lazy` 加载，侧栏与首屏不背它；`localStorage` 键以 `storageKey` 为前缀。
- 独立入口与嵌入模式共用同一对组件与同一份状态；独立入口的接口前缀默认同源，开发时由代理转发到管理台。

## 模块结构

- `web/src/module.tsx`：模块工厂、选中同步、状态栏、跳转动作与 `resumeSession` 命令。
- `web/src/chat-context.tsx`：home、对话参数草稿、对话列表、SSE 连接、流式文本、扩展 UI 请求与错误状态。
- `web/src/components/ChatSidebar.tsx`：home 选择、新建对话参数、对话列表。
- `web/src/components/ChatWorkspace.tsx`：轨迹渲染、流式块、扩展 UI 提示与输入区。
- `web/src/main.tsx` 与 `index.html`：独立入口；`module.css` 是 `./module.css` 导出给宿主的样式，`standalone.css` 只服务独立入口的两栏版面。
