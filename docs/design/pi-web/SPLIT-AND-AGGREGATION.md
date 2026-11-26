---
parent: ../..
references:
  - ../../../apps/pi-manager-web/SPEC.md
  - ../../../apps/pi-sessions-web/SPEC.md
  - ../../../apps/pi-sessions-web/server/HTTP.md
  - ../../../apps/pi-web/SPEC.md
  - ../../../packages/workspace-shell/MODULE-CONTRACT.md
---

# Pi 能力的职责拆分与再聚合

## 目标

`apps/pi-web` 是完整的 Pi 前端：会话对话、会话列表、文件浏览、终端、模型与技能配置、MCP、subagent、推送通知全在一页里，是 git subtree 接进来的上游代码。日常用着没问题，但每块都与 pi home、凭据、运行时绑在一起，无法按需启停，也难被别的场景复用。

已经拆出来的两块：

- **pi-manager-web**：pi home 的配置管理与执行（settings、skills、subagent、MCP、模型、凭据、一次性任务）。写文件、加锁、遮蔽凭据，风险高。
- **pi-sessions-web**：会话内容的浏览与渲染（任意根目录的 `.jsonl`、轨迹视图、关注与删除）。只读为主，风险低，可独立部署。

拆开后的缺口：完成 pi-web 原本的一件事（选模型 → 起会话 → 看它在跑什么 → 回看轨迹 → 改配置）要在两个页面之间跳，谁也不认识谁。

本设计解决两件事：

1. **怎么聚合**：把两个模块放进同一个工作台，让"任务跑完看轨迹""切到某个 home 看它的会话"一次点击完成。
2. **为什么聚合不废掉拆分**：给出硬边界，让后续每个新能力都能明确只落在一个模块里。

## 拆分判据

拆分不是按页面切的，是按四件不同的事切的：

| 维度 | pi-manager-web | pi-sessions-web | 合并后会发生什么 |
| --- | --- | --- | --- |
| 做的事 | 控制面：改配置、起会话、管凭据 | 内容面：读会话、渲染轨迹、关注与删除 | 读写策略混在一起，谁都不敢收紧权限 |
| 写权限 | 多文件写，需要乐观锁、备份、凭据遮蔽 | 只删自己根目录内的会话文件 | 删除能力跟着管理台一起被暴露 |
| 运行依赖 | pi SDK（可选加载）、模型凭据 | 零依赖，不加载 pi | SDK 缺失或凭据过期时会话浏览跟着挂掉 |
| 复用地 | 独立管理台站点 | 独立浏览站点 + 工作台模块 | 谁也无法单独给别人用 |

四条硬边界，后续新增能力按它们判断归属：

1. **不共享数据模型，只共享身份**。跨模块只传普通值：pi home 路径、会话 id、会话文件路径、会话根目录。禁止把一方的 store、实体对象、内部 API 交给另一方。
2. **不 import 对方内部实现**。跨模块只走「接收方导出具名命令 + 组合根注入」，写在 `shell-web/src/registry.tsx`，删掉接收方会编译失败。
3. **不在两个地方实现同一件事**。轨迹渲染只有 `pi-sessions-web` 一份（服务端转换 + `pi-agent-trajectory-viewer`），配置写入只有 `pi-manager-web` 一份，会话根推导也只有一处。
4. **能力可单独消失**。从组合根删掉一个模块，另一个仍然可用：没有会话模块时管理台只是少了「看轨迹」按钮；没有管理模块时会话模块只是少了运行中状态。

## pi-web 能力归属盘点

| pi-web 现有能力 | 归属 | 现状 |
| --- | --- | --- |
| 会话列表、删除、搜索、统计 | pi-sessions-web | 已覆盖 |
| 会话轨迹、分支、诊断视图 | pi-sessions-web | 已覆盖 |
| settings、skills、plugins、subagent、MCP、模型与凭据 | pi-manager-web | 已覆盖 |
| 一次性任务执行 | pi-manager-web | 已覆盖（`/api/session/*`），缺界面 |
| 会话运行态（谁在跑、跑到哪） | 管理台采集，会话模块展示 | 本设计补上 |
| 交互式对话（流式、工具确认、打断、续聊） | pi-chat-web（运行时在管理台） | 见 [Pi 交互对话](../pi-chat-web/CHAT.md) |
| 文件浏览、git diff、worktrees、open-in-explorer | fs-web 等既有模块 | 不在本设计范围 |
| 终端（本地 PTY） | ssh-web 已有远端终端，本地 PTY 另议 | 不做 |
| 推送通知、app 更新、provider 用量、project-trust | 无 | 不做 |
| 登录鉴权 | 部署侧（反代或可信局域网） | 不做 |

`apps/pi-web` 在阶段一保持原样可用；它退场的前提是阶段二完成。

## 聚合形态

聚合发生在**工作台外壳**（`shell-web`）这一层，不把两个后端合进一个进程：

```
shell-web（组合根 registry.tsx）
├─ pi-chat 模块 ──/api/pi-manager/*（对话运行时）──┐
├─ pi-config 模块 ─/api/pi-manager/*（配置与 home）┴▶ 管理台服务（8093，独立进程）
├─ pi-sessions 模块 ─/api/pi-sessions/*─▶ 会话服务（30200，独立进程）
└─ 其它既有模块（fs / ssh / todo / flow …）
```

- 组合根只做三件事：调两个工厂、注入跨模块命令、声明 profile。它不读任何模块的内部状态。
- 两个服务仍是独立进程、独立端口、独立状态目录；生产用一个反代按前缀分发，与 ssh / flow 的既有做法一致。
- 模块各自保留独立入口：管理台仍是 8093 的独立站点，会话浏览仍是 30200 的独立站点。工作台是第三个入口，不是唯一入口。

## 模块边界改造

### pi-manager-web 变成工作台模块

现在它是独立站点（`App.tsx` 自己画顶栏、home 列表、分区内容、运行中会话面板）。按 `MODULE-CONTRACT` 改造：

- 新增 `web/src/module.tsx`，导出 `createPiManagerModule({ apiBaseUrl, storageKey, openSession?, openRootInSessions? })`，返回 `WorkspaceModule & { commands }`。
- `Sidebar`：上段是 pi home 清单（切换、新增、右键菜单，沿用现有交互），下段是分区导航（常规 / 模型 / skills / subagent / MCP / 插件 / 凭据 / 任务）。侧边栏内部两级结构在契约允许范围内。
- `Workspace`：当前分区内容。七个既有分区组件与 store 不动，只把宿主位置从 `.config-detail` 换成模块工作区。
- 顶栏（当前 home 名称与路径）合进侧边栏头部；状态栏信息通过 `context.Status` 发布。
- `context.kind = 'pi.home'`。**store 是真源，选中单向派生**：照 `pi-sessions` 里 `SelectionBridge` 的写法，home 变化时 `select({ kind: 'pi.home', id, label })`，清空时只清自己这一类 kind。
- 删除 `SessionsPanel.tsx`：运行中会话的展示归会话模块。随之处理的字段：`parentSessionFile`（子会话关系）、`mode`、`pid`、`host`、`stale`、`warnings` 交给会话模块的运行态叠加；`pluginDetected`（心跳扩展未安装提示）留在管理台的「任务」分区，因为它才知道 home。
- 新增「任务」分区：列出 `GET /api/session/tasks?home=<绝对路径>` 的任务（agent、subagent、state、耗时、最后一条助手文本），发起任务的表单也在这里，替代现在只有 API 没有界面的状态。选中某条任务时发布 `pi.task` 选中，并注册 `pi.task` 的 actions：「打开轨迹」「取消任务」。「打开轨迹」在 `run` 里拿 `ShellHandle` 调 `openSession(...)` 再 `shell.reveal('pi-sessions')`；会话模块未启用时用 `shell.enabled('pi-sessions')` 给 `disabledReason`。
- 新增 `pi.home` 的 action：「在会话模块打开该 home」，调注入的 `openRootInSessions(home)` 再 `shell.reveal('pi-sessions')`。
- 客户端要支持注入前缀：`web/src/api/client.ts` 现在用 `window.location.origin` 且在路径里写死 `/api`，改成接受 `baseUrl` 工厂（独立入口传 `/api`，工作台传 `/api/pi-manager`）。`shell-web` 的 vite 代理加 `/api/pi-manager` → `8093` 并 rewrite 回 `/api`。

### pi-sessions-web 增加运行态叠加与打开命令

它继续拥有「会话」这个实体（磁盘文件 + 轨迹渲染），不足的是运行态：

- `createPiSessionsModule` 增加可选注入 `liveSessions?: { fetch: () => Promise<LiveSessionFeed> }`。`LiveSessionInfo` 是会话模块自己声明的结构类型，不 import 管理台的任何类型；管理台实现只要结构匹配即可。未注入时模块完全按现状工作。
- 侧栏加叠加层：磁盘行按 `resolve(sessionFile)` 与运行态匹配，命中则显示运行中 / 空闲、模型；只存在于运行态、磁盘没有的行单独显示（文件还没落盘）。一个磁盘行可能对应多条运行态（子会话共享父会话文件），取 `status === 'running'` 优先，其余折叠为子会话标注。
- 搜索、关注、删除、按日筛选保持不变；分组从"按项目"扩成"运行中组在最前，其后按项目"。
- 新增命令 `openSession({ root, sessionFile?, id })`：切根目录（若不同）、等列表到达后按 `sessionFile` 优先、`id` 兜底选中，并把该会话所在日期并入日期筛选，保证跳过去就看得见。根不可读或两条都不在扫描结果里时抛错，不发半截请求。它需要 controller 增加一个 `pendingSelection` 通道，因为 `setRoot` 目前会同步清空选中，`useSessions` 的加载也不返回承诺。
- 已有的 `openRoot(root)` 保持不变，继续给「打开某目录的会话」用。
- 运行态失败静默降级：保留磁盘列表，只在侧栏底部给一行小字，不复用列表的错误通道。

### 服务端改动

管理台服务端：

- `GET /api/session/live` 改成不带参数：扫描所有已登记与已发现 home 的心跳目录，返回 `{ sessions, stale, warnings, now }`，`sessions[]` 的字段至少包含 `sessionId`、`sessionFile`（绝对路径）、`parentSessionFile`、`cwd`、`name`、`model`、`mode`、`status`、`host`、`sameHost`、`pid`、`startedAt`、`updatedAt`。会话模块按绝对路径匹配，不需要知道 home。
- `GET /api/session/tasks` 增加 `?home=<绝对路径>` 过滤（现在只有 `?agent=`）。
- 新增 `GET /api/session/disk?home=` 返回 `{ root, exists }`：会话根的读出口，供跨模块跳转使用，前端不自己拼路径。
- 会话根只在一个地方定义：`join(home, 'sessions')`，与 `session-task.ts` 写会话的位置一致。settings 的 `sessionDir`、`--session-dir` 与环境变量属于运行期覆盖，管理台不追踪，写进边界说明。
- 不再做「把会话服务挂进管理台」这类改造：轨迹渲染只有一个宿主。

会话服务端零改动。

## 组合根的接线清单

构造顺序是单向的：先建会话模块（它的运行态来源只是一个调用 8093 的普通函数，不依赖管理台模块对象），再建管理台模块并把会话模块的命令注入进去。

```tsx
// 运行态来源是普通函数：直接调管理台服务，不 import 管理台模块。
const liveClient = createLiveClient('/api/pi-manager')
const sessions = createPiSessionsModule({
  apiBaseUrl: '/api/pi-sessions',
  storageKey: 'ursi.sessions',
  liveSessions: { fetch: () => liveClient.fetchFeed() },
})
const config = createPiManagerModule({
  apiBaseUrl: '/api/pi-manager',
  storageKey: 'ursi.pi-config',
  openSession: sessions.commands.openSession,
  openRootInSessions: sessions.commands.openRoot,
})
```

| 边 | 形式 | 说明 |
| --- | --- | --- |
| pi-config → pi-sessions | `openRootInSessions: sessions.commands.openRoot` | 在会话模块打开某 home 的会话根 |
| pi-config → pi-sessions | `openSession: sessions.commands.openSession` | 任务行一键看轨迹 |
| pi-sessions → pi-config | `liveSessions: { fetch }`（普通 HTTP 函数） | 运行中状态叠加，不引入模块依赖 |
| profile | `{ id: 'pi', title: 'Pi 控制台', modules: ['pi-config', 'pi-sessions', 'fs-web'] }` | 两者同屏，配置与会话互跳 |

- 状态栏由外壳按**当前展开的模块**留槽（`shell.tsx` 的现状），因此两个模块各发各自的状态：管理台发 `pi.home`，会话模块发 `pi.session`。选中属于哪个模块不影响槽位，文档与验收按这个事实写。
- 「禁用模块」只影响界面：注入的函数是模块级一次性构造，profile 里去掉 `pi-config` 不会停止会话模块拉运行态。真正消失靠从组合根删除该模块。
- 新增的 `pi` profile 只在首次落盘默认值时生效，老环境需要在 Profiles 页恢复默认，这一点写进验证步骤。

## 会话叠加契约

```ts
interface LiveSessionInfo {
  sessionId: string
  sessionFile: string | null     // 会话文件绝对路径，管理台侧已归一化
  parentSessionFile: string | null
  cwd: string
  name: string | null
  model: string | null
  mode: string
  status: 'running' | 'idle'
  host: string
  sameHost: boolean              // 采集侧算好，会话模块不猜 hostname
  pid: number
  startedAt: number
  updatedAt: number
}

interface LiveSessionFeed {
  sessions: LiveSessionInfo[]
  stale: number
  warnings: string[]
  now: number
}
```

叠加规则：

- 匹配键是 `resolve(sessionFile)` 与磁盘行的 `path`；两条链路都由 pi 写绝对路径，不做 `realpath`（文件刚创建时 realpath 会失败）。
- 只有运行态、没有磁盘行：文件还没落盘，行标注"待写入"，选中后提示稍后刷新。
- 只有磁盘行、没有运行态：历史会话，不标"空闲"（进程早就不在了）。
- `sameHost === false`：文件在本机读不到，不提供轨迹入口，行内标注主机名。
- 同一 `sessionFile` 对应多条运行态：取运行中的那条作为主行状态，其余在同一条行下标注为子会话。
- 轮询与正文重读在会话模块内部，但要写进它的 SPEC 验收：运行态 5 秒、磁盘列表 10 秒（面板展开且页面可见时）；正文在 `modified` 变化、手动刷新或会话从 `running` 转 `idle` 时重读，自动重读设体积与最小间隔门槛。这会替换 `SessionWorkspace` 里"正文不跟列表对象走"的现有注释，属于明确的行为变更。

## 聚合层不做什么

- **不自动跟随 home**。管理台切 home 不改会话模块的根：会话模块的根是它自己的偏好，用户可能正在看备份或别人导出的会话集。要跟随时用「在会话模块打开该 home」这一个显式动作。
- **不在管理台里再渲染一份轨迹**。哪怕复用同一个组件，也会造出第二个渲染宿主，样式、刷新策略、大文件处理要维护两遍，等于把会话模块的职责搬回配置台。
- **不用 iframe 套 pi-web 当聚合**。现在的 `pi-web-panel` 就是这么做的：一页里两套侧栏、两套选中、两套主题，无法共享选中与命令。聚合要的是模块，不是嵌套页面。
- **不合并后端进程**。配置写入与会话读取的失败域必须分开：配置目录坏掉不影响看历史会话，会话目录只读也不影响改模型。
- **不引入共享 store**。组合根只传函数与普通值；一旦需要共享状态，说明边界画错了。

## 交互式对话的位置

聚合后剩下的是 pi-web 的核心能力：交互式对话。它不再挤进管理台或会话模块，而是独立成第三个模块 `pi-chat-web`，详见 [Pi 交互对话](../pi-chat-web/CHAT.md)：

- 运行时归管理台（SDK、home、凭据、限流都在它手里，对话与一次性任务共用 `session-runtime.ts`），对话界面归 chat 模块，历史轨迹仍归会话模块。
- chat 编译期依赖管理台的公开客户端 `@ursi/pi-manager-web/client`，运行期依赖管理台服务；不 import 管理台的 store 与组件。
- 会话模块与会话模块之间不产生新依赖：跳转与续聊都通过组合根注入的命令完成，传的只是会话文件路径。
- 三条硬边界保持不变：轨迹渲染只有会话模块一份，配置写入只有管理台一份，chat 只持有一份对话界面。pi-web 在 chat 可用后从 profile 移除，subtree 保留作参考。

## 落地状态

- 已完成：`pi-config` 模块、`pi-chat` 模块、`pi-sessions` 的运行态叠加与两条命令、组合根接线、`/api/pi-manager` 代理、管理台会话运行时与对话接口。管理台样式由 `scripts/scope-css.py` 作用域化成 `module.css`，不污染外壳。
- 待办：`pi-web` 尚未从 profile 移除（等对话能力在真实使用中稳定）。

## 落地顺序与验证

1. **会话模块接收运行态**：`liveSessions` 注入点、叠加与分组、`openSession` 命令与 `pendingSelection` 通道、日期筛选并入、失败静默降级。验证：`vitest` 覆盖路径匹配、缺失文件、跨机 host、子会话折叠、跳转后日期筛选自动放开；未注入时现有用例全绿。
2. **管理台服务端**：`live` 无参全量扫描（含已发现 home）、`tasks?home=` 过滤、`sameHost` 与 `parentSessionFile` 进返回值。验证：`node --test src/*.test.ts`。
3. **管理台模块化**：`module.tsx`、侧栏两级结构、`pi.home` 单向派生、删除 `SessionsPanel`、新增任务分区与 `pi.task` actions、`client.ts` 支持注入前缀。验证：`npm run typecheck`；独立入口与工作台入口共用同一批组件。
4. **组合根接线**：两条命令、一个运行态来源、一个 profile、Registry 页展示。验证：`shell-web` 代理加 `/api/pi-manager`；Profiles 页恢复默认后出现 Pi 控制台；任务行跳转后落在会话模块工作区并选中目标会话；会话模块未启用时「打开轨迹」给禁用原因。
5. **文档同步**（见下）。
6. 手测清单：改完配置立即在同一 home 的会话侧看到结果；任务跑完跳转后轨迹跟着轮次增长；装心跳扩展的 CLI 会话出现在"运行中"；跨机心跳不提供轨迹；子会话折叠标注正确；管理台停掉时会话浏览不受影响；管理台模块从组合根删除后会话模块只少运行态。

## 文档改动

- `apps/pi-manager-web/SPEC.md`：新增「作为工作台模块接入」（工厂、侧栏两级、`pi.home` 单向派生、`pi.home` 与 `pi.task` 的 actions、任务分区、可注入 `apiBaseUrl`），把「查看运行中的 pi 会话」改为「提供会话运行态数据」，模块结构补 `module.tsx`、任务分区，删除 `SessionsPanel` 相关描述。
- `apps/pi-sessions-web/SPEC.md`：新增「接入工作台的运行态叠加」与 `openSession` 命令的验收，明确运行态是可选注入、结构类型自持、未注入时行为不变；把轮询与正文重读条件写进验收。
- `apps/pi-sessions-web/server/HTTP.md`：说明运行态不在本服务内，由宿主提供。
- 根 `SPEC.md`：Pi 管理台与 Pi 会话浏览两段各补一句聚合关系。
- `ARCHITECHTURE.md`：模块职责与模块关系补「Pi 控制台由配置模块与会话模块在工作台里组合，两者仍可独立部署」，设计索引已登记本文件。
