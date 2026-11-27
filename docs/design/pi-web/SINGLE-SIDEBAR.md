# Pi 模块单一侧栏设计

## 结论

Pi 模块从「三段切换 + 各自侧栏」改为「一个侧栏、一个会话页、一个配置页」。

- 侧栏从上到下三段：pi home 管理区、目录与会话列表、底部按钮排（新对话、配置）。
- 工作区只有三种页面：会话页（只读轨迹与续聊是同一页面的两种模式）、新对话页、配置页。
- 「开始新对话」没有表单。cwd 取侧栏里点选的目录，composer 栏上可以改。

## 为什么要改

现在三个视图各一个侧栏，顶部三段切换。用户找一条会话要在「对话」和「会话」两处找，而两处列的是同一批实体的不同投影：对话侧栏列本进程装配过的，会话侧栏列磁盘上扫到的。「在对话里继续」这个按钮存在的唯一理由是三段切换。

home 选择有三处入口（配置侧栏、对话侧栏下拉、`PiProvider`），靠两个 Bridge 组件双向同步。会话根目录又被 `SessionsBridge` 强制拉回 home 的 `sessions/`：它的依赖数组里有 `root`，用户选完外部目录 `root` 一变，effect 立刻把它拉回。注释写「单向同步」，实际是强制覆盖。这是一个现成的 bug，先单独修。

## 结构

```
PiProvider        home 与 homes 的唯一真源（home store 提到组合根）
  └ PiNav         当前页面与当前目录（新建，替代 PiView / bridges / 三个 Bridge 组件）
      ├ DraftPage      新对话：只有 composer
      ├ SessionThread  一条会话：只读轨迹 或 续聊
      └ ConfigPage     配置：原配置工作区整体搬过来
```

### 侧栏

```
┌──────────────────────────────┐
│ Pi                 [↻] [↑]   │  SidebarFrame 头
├──────────────────────────────┤
│ ● agent        ~/.pi/agent   │  home 管理区（列表，当前项高亮）
│   work         ~/pi-work     │
│ [+ 新增]                      │
├──────────────────────────────┤
│ 📁 ~/.pi/agent/sessions  [切换]│  目录行（点「切换」开目录面板）
│ ▁▃▅▂▇▃▁  今天 · 全部        │  按日筛选（沿用）
│ [🔍]                         │  搜索（沿用）
│ ── 特别关注 ──               │
│ ▾ dev/ursi-flow          161 │  目录 = 项目组，组头可点选
│     · 会话标题      2h       │
│ ── 全部项目 ──               │
│ ▸ tmp/costrict-security  492 │
├──────────────────────────────┤
│ [+ 新对话]        [⚙ 配置]   │  底部按钮排
└──────────────────────────────┘
```

1. **home 管理区**：列表，不是下拉。每行显示名字与路径短名，无效的标灰。点一行切换 home。「新增」展开内联面板，复用配置侧栏的 `CreatePanel`。重命名与移除放每行右键菜单。home 的增删改走新的 `pi-home-store`。
2. **会话列表**：与现在 `SessionsSidebar` 的内容一致，去掉外层 `SidebarFrame`。项目组组头可点选，点选后成为「当前目录」。组头显示相对路径（见下）。
3. **底部按钮排**：新对话、配置。`SidebarFrame` 折叠时把整段收成窄条，`pi-sidebar.tsx` 里「折叠时 hidden 保状态」的补丁删掉，`switch.css` 整个文件删掉。

### 工作区

`PiNav` 持有：

```ts
type PiPage =
  | { kind: 'draft' }
  | { kind: 'session'; sessionFile: string }
  | { kind: 'config' }
cwd: string | null
```

页面不持久化，刷新回到 `draft`。`cwd` 在换 home 时清空。

| 动作 | 结果 |
|---|---|
| 点会话行 | `session(sessionFile)`，只读渲染轨迹 |
| 在会话页 composer 发消息 | 先 `resume(sessionFile)` 再 `submit`，页面不变，轨迹切到流式 |
| 点组头 | `cwd = group.key`，页面不变 |
| 点「新对话」 | `draft` |
| 点「配置」 | `config`，返回时回到进入前的页面 |
| 结束对话 | `draft` |

**会话页** `SessionThread`：

```
SessionThread(sessionFile)
├─ row = listing 里按 path 找
├─ live = chat.active?.sessionFile === sessionFile
├─ 只读轨迹 = useReadOnlyTrajectory(root, row.id)（live 后不再触发）
├─ entries = live && transcript ? parsePiJsonl(transcript) : 只读轨迹
├─ revision = 本地计数器，entries 变一次加一
├─ header：标题、cwd、状态、停止、结束
├─ banners：只在 live
├─ thread：TrajectoryViewer + live 时的 thinking / partial / tools / pending
├─ ui-request：只在 live
└─ composer：textarea、目录、模型、思考、发送
```

只读切续聊时丢掉只读 entries，改用 SSE 首帧的整份 transcript。两者是同一份数据（服务端 `chat.transcript`），不需要再拉一次。`resume` 返回到 SSE 首帧到达之间，`transcript` 为空，这期间继续渲染只读 entries。

**配置页**：原 `ManagerWorkspace` 整体搬过来，它自己的左列表就是六个分区。首次进入才挂载，挂载后保留。

### 新对话的 cwd

`cwd` 只从两处来，**扫描根永远不是 cwd 来源**：

- 点组头：`cwd = group.key`（`projectKey` 就是 cwd 原文）。
- 点会话行：`cwd = row.cwd`。

都没选时 `cwd = null`，composer 显示「点左侧一个目录」，发送禁用。composer 栏上有一个目录输入框，和模型、思考级别并列，默认值是 `cwd`，可以改成任意路径。`ChatDraft.cwd` 保留，`submit` 用 `draft.cwd || nav.cwd`。

## 关于「树级结构」

实现为**一层目录加会话**，不做多级目录树：

- `projectKey` 就是会话头里的 `cwd` 原文，一层分组已经就是「目录 → 会话」。
- 多级目录树表达的是不存在的包含关系：`/tmp/a` 和 `/tmp/b` 下跑过的会话在树里是兄弟，但它们之间没有任何关系。本机 692 个项目里 `--data-dev-*` 一族占大头，按 `/` 切后第一层只有三五个节点。

为了让人一眼看到层级，补两件事：

- 组头显示**相对路径**：对当前所有 `projectKey` 求最长公共目录前缀，组头显示 `dev/ursi-flow` 而不是 `ursi-flow`，`title` 给全路径。
- **搜索命中时命中的组全部展开**，命中目录名的组排最前。现在搜到 30 条散在 20 个组里，20 个组全折叠，要逐个点开。

## 「打开中的对话」列表为什么能删

它和会话树打的是同一个接口 `GET /api/sessions`，只是 query 不同。逐项对：

| 信息 | 树上 |
|---|---|
| 运行中 | 绿点 |
| 模型 | 有 |
| 出错 | 要补：`live.status` 加 `error` |
| 思考级别、排队数、正在吐字 | composer 的事，不是列表的事 |
| 还没落盘的新对话 | 落盘前树上看不到，可接受 |

## 文件改动

新建：

| 文件 | 职责 |
|---|---|
| `pi-nav.tsx` | `PiPage` 与 `cwd` 的真源 |
| `pi-home-store.ts` | home 列表与增删改（从 `views/config/store/app-store.ts` 拆出） |
| `views/sessions/components/SessionThread.tsx` | 会话页 |
| `views/sessions/components/DraftPage.tsx` | 新对话页 |

修改：

| 文件 | 改动 |
|---|---|
| `pi-context.tsx` | 删 `PiView`、`view`、`setView`、`useActivation`、自己 fetch `/api/homes`。读 `pi-home-store` |
| `pi-sidebar.tsx` | 重写为单一侧栏 |
| `pi-workspace.tsx` | 按 `PiNav` 渲染三种页面 |
| `pi-status.tsx` | 按页面给摘要。不显示运行中数量（侧栏脚注已有） |
| `module.tsx` | 删 `WireBridges`、`ChatBridge`、`ConfigBridge`、`SessionsBridge`。子模块 Provider 在这里直接实例化 |
| `views/sessions/components/SessionsSidebar.tsx` | 去掉 `SidebarFrame`，导出 `SessionsPanel`；组头可点选、显示相对路径 |
| `views/sessions/sessions-context.tsx` | 删 `resumeInChat`、`pendingSelection`；根目录只在 home 变化那一刻跟随 |
| `views/sessions/hooks/useGroupFold.ts` | 有搜索词时命中的组全部展开 |
| `views/sessions/lib/format.ts` | 组头相对路径；`groupSessions` 返回值带 `commonPrefix` |
| `views/sessions/api.ts` | `fetchSessionText` 识别 `content-type` 为 JSON 时取 `.text`（有运行时的 `/trajectory` 返回 JSON） |
| `views/chat/chat-context.tsx` | `activeId` 改为从 `sessionFile` 派生；删 `homes`、`setHome`、`selectChat`、`startNewChat`、`openTrajectory`、恢复上次对话的 effect、`lastChatKey` |
| `views/config/module.tsx` | 删 `ManagerSidebar`、`open-home-sessions` action |
| `views/config/store/app-store.ts` | home 相关字段与动作搬到 `pi-home-store.ts`，`configureApiBase` 的全局副作用一并处理 |
| `apps/pi-web/SPEC.md`、`docs/design/pi-web/OVERVIEW.md` | 「三个视图」改为「一个侧栏、三种页面」；「首次激活才挂载」改为「侧栏挂载即扫描」 |

删除：

| 文件 | 原因 |
|---|---|
| `bridges.ts` | 三个可变引用全没了 |
| `switch.css` | `pi-switch-*` 只在它和两个要重写的文件里出现 |
| `views/chat/components/ChatSidebar.tsx` | 表单删掉，列表由树上的绿点表达 |
| `views/chat/components/ChatWorkspace.tsx` | 拆进 `SessionThread` 与 `DraftPage` |
| `views/sessions/components/SessionWorkspace.tsx` | 并入 `SessionThread` |
| `views/chat/module.tsx`、`views/sessions/module.tsx` | 不再是独立 `WorkspaceModule`。它们的 shell `actions`（「在对话里继续」「看完整轨迹」）和 `commands` 一起删，`sessions/module.test.tsx` 的「跨模块命令」一节整节删，其余 8 个用例迁到 `module.test.tsx` |

## 顺序

1. 修 `SessionsBridge` 与 `externalRoot` effect 的根目录强制拉回。单独提交。
2. 数据层：`pi-home-store` 收口 home，`pi-nav.tsx` 落地，删 `bridges.ts` 和三个 Bridge 组件。UI 不变，三个旧侧栏改从新 store 读。
3. UI 层：侧栏合一，`SessionThread` 合并只读与续聊，删五个文件，重写测试与 SPEC。

第 2 步做完 UI 还是三个旧侧栏，但 home、页面、目录都只有一份真源。第 3 步只动 JSX 和样式。

## 风险

- **新对话建完后 `sessionFile` 为空**：`createChat` 返回时 `sessionFile` 要等 SSE 的 `state` 帧才补。`PiNav` 从 `draft` 切到 `session` 必须等这个值，加一个 effect 监听 `chats[0].sessionFile` 从 `null` 变非 `null`。
- **`refreshChats` 按 home 过滤**：`resume` 一条属于别的 home 的会话时列表会刷新，保留条件从「`activeId` 那条」改为「`sessionFile` 那条」。
- **`TrajectoryViewer` 的 `sessionRevision`**：只读用 `row.modified`，续聊用本地计数，两套值域。统一用 `SessionThread` 的本地计数器，与来源无关。
- **`/trajectory` 的运行时分支返回 JSON**：`SessionThread` 在 `live` 为真后不再触发只读加载，`fetchSessionText` 同时识别 `content-type`。
- **侧栏挂载即扫描**：`useSessions` 与 5 秒 live 轮询在 Provider 里，侧栏一挂就跑。这是必须的（树要显示），改 SPEC 的「首次激活才挂载」。
