---
parent: ../../SPEC.md
references:
  - HTTP.md
  - ../../docs/design/pi-web/OVERVIEW.md
  - ../../packages/workspace-shell/MODULE-CONTRACT.md
  - ../../docs/design/location/URI-CONTRACT.md
---

# Pi Web

## 功能意图

pi coding agent 的浏览器端：配置、对话、会话浏览三件事操作同一套领域模型。

一份 pi home 决定整套能力（模型、凭据、skills、agents、MCP、工具策略），因此 home 是全应用唯一的上下文轴：配置写它的注册表字段，对话用它装配运行时，会话浏览的默认根是 `<home>/sessions`。

会话只有一个身份 `sessionId`（会话头 `SessionHeader.id`）。磁盘上的历史文件、内存里加载的会话、正在收发的对话、一次性任务、子会话，都是同一个 `PiSession` 实体的不同状态投影；运行态（本进程与其它进程的心跳）挂在实体的 `runtimes` 上，不再有独立的运行态接口。

交付形态：

- `server/`：一个零依赖 Node 24 进程，托管 `/api/*` 与独立页面；pi SDK 按需加载。
- `web/`：一个工作区模块 `pi`，一个侧栏（home 管理区、目录与会话列表、底部按钮排）与两种页面（会话、配置）。设计见 `docs/design/pi-web/SINGLE-SIDEBAR.md`。
- 数据与状态：`$URSI_HOME/pi-web`（home 清单、扫描索引、特别关注、模型目录缓存）；会话文件仍写在各自 pi home 的 `sessions/`。

边界：不做多用户与鉴权（部署在可信局域网，入口防护由前置层承担）；不做终端、文件浏览、附件与图片输入；不改写别人的会话内容（唯一写操作是删除会话文件与记录特别关注）。

## 关键功能与验收

### pi home 实体

#### 验收

- `GET /api/homes` 的每条记录都带 `sessionsRoot`、`profileRevision` 与 `capabilities`（skill / agent / mcp / 插件数量、默认模型、是否有可用凭据），前端不自己拼路径或统计。
- home 清单原子落盘到 `$PI_WEB_STATE/homes.json`；条目 id 是 realpath 的 sha256 前 16 位，跨重启稳定。
- 创建支持初始化、复制、登记三种模式，只创建最后一级目录，目标已存在且非空返回 409。路径输入可展开目录浏览器（`GET /api/homes/browse`，任意目录、只列子目录、`~` 服务端展开）逐级选择后回填。
- 目录入参是[位置契约](../../packages/location/SPEC.md)的 URI：接受 `file:///abs/path` 与本机简写（裸绝对路径、`~`），响应返回 realpath 后的 URI。pi 只在本机运行，`ssh://` 入参一律拒绝，选目录器不接设备切换。
- `GET /api/homes/:id/runtime-profile` 返回服务端解析好的模型候选（`enabledModels` 范围、provider 与显示名、支持的思考档位与映射）、subagent 清单、默认 cwd 与会话根；前端不重算匹配规则。
- 配置写入返回新的 `profileRevision`；该 home 下已加载的会话据此标记 `stale`。

### 会话实体

#### 验收

- 会话 id 取会话头 `id`；服务端创建时用 uuidv7 铸造并经 `SessionManager.create(cwd, dir, { id })` 写入文件头，内存态与磁盘态同键。
- 无头部老文件按 `(filePath, 首行内容)` 哈希派生 id，`identitySource = 'derived'`，不改写磁盘；这类会话只读（`canRun=false`，原因码 `legacy_without_header`）。
- `GET /api/sessions` 支持 `home`（home 路径或 id）与 `root`（任意绝对目录）两种作用域，返回同一份实体：实体归属跟随最近一次扫到它的作用域（运行中的除外），换一种访问方式列表不变空；带 `since` 时未变化回 `notModified`，变化回完整列表（epoch 不匹配时要求整份重取）。
- 扫描只收 `*.jsonl`，跳过名为 `subagents` 的子目录：pi 把子代理对话记在 `<会话id>/subagents/` 下，文件头只有父会话 id，它们不是独立会话。
- 外部目录按 LRU 维护（默认 4 个）并带空闲 TTL（默认 30 分钟），过期即移出扫描目标，其下 `discovered` 实体被移除，文件不动。
- 状态机：`discovered → loading → ready ⇄ running`，旁支 `failed`，`evicted` 回流 `discovered`，`deleted` 终态。`loading` 与 `running` 的删改分别返回 409 `session_loading` / `session_busy`。
- 同一 `sessionId` 的装配单飞：并发「继续」拿到同一个运行时，不出现并行追加同一份 JSONL。
- 上游 `sessionFile` 不是跨接口的键：删除与续聊都只按实体 `sessionId` 定位，客户端不传路径。续聊时服务端按实体的 `filePath` 打开文件，home 按实体归属取；能否续聊由 `capabilities.canContinue` 给出，不能续聊返回 409 `session_not_continuable`。

### 轨迹

#### 验收

- `GET /api/sessions/:id/trajectory` 返回该会话唯一的轨迹：首行补齐 `type: "session"`、老写法映射成 `message` 行、坏行丢弃并计数；这是会话页只读模式与续聊模式共用的同一份权威。有运行时的会话返回 JSON 包裹（`{ text, revision, source: 'runtime' }`），客户端按 `content-type` 识别。
- 文件存在本地运行时且已落盘内容时以运行时为准，其它情况以文件为准；接口形态一致。
- 体积超过上限返回 413 与中文说明；支持 gzip 协商。
- 事件流 `GET /api/sessions/:id/events` 只对存在本地运行时的会话开放，帧带 `revision`，重连按 `since` 续接。

### 侧栏与页面

#### 验收

- 侧栏只有一个，从上到下：pi home 管理区（列表，点一行切换，右键重命名/移除，「+」展开新增面板）、目录行（点开目录面板切任意目录）与按项目分组的会话列表、底部按钮排（新对话、配置）。折叠成 32px 窄条时只显示 home 名。
- home 只有一份真源（`pi-store`）：侧栏切换后，会话列表的根换成该 home 的 `sessions/`，当前目录清空，页面离开会话页。用户把根改成任意外部目录不会被 home 拉回。
- 工作区两种页面：会话页、配置页（六个分区，首次进入才挂载，挂载后保留；退出回到进入前的页面）。页面不持久化，刷新回到空会话页。
- 会话页只有一个，路由键只用 `sessionId`：`id` 为空是空会话页（原「新对话页」），非空是某条会话。建立、发起、继续三种动作都在这一个页面的同一个输入框里完成：空会话页发首条消息才建会话（`createChat`），建完页面原地填上 id，不换页、不重挂输入框；点会话行进入已有会话，发消息先装配运行时（只传 `sessionId`）再发送，轨迹切到事件流里的权威 transcript。
- 空会话页没有表单：目录来自侧栏点选的组头（`cwd = projectKey`）或会话行（`cwd = row.cwd`），都没选时发送禁用。模型与思考级别在输入框栏上选。
- 会话页入口只有一个：侧栏点会话行。右键菜单给复制标识、释放运行时（仅本进程装配过的会话可用）、删除，不再重复给「打开」。
- 会话页：点会话行进入，只读渲染轨迹（`GET /api/sessions/:id/trajectory`）；停止、排队、扩展 UI 回执与原对话视图一致；会话内换模型只影响本会话。运行时的释放是资源管理，不是用户意图，入口在侧栏会话行右键「释放运行时」，空闲 30 分钟与服务进程退出也会自动释放。
- 会话列表：按项目分组（一层目录，`projectKey` 就是会话头里的 `cwd` 原文），组头显示相对所有项目公共前缀的路径，点组头把该目录设为当前目录；按日筛选、搜索、特别关注、删除、查看轨迹。默认不按日期筛，几天没打开时首屏就是全部会话；最近 7 天的条形可多选，「全部」清空筛选；活着的会话（实体上有任一运行态，含空闲）豁免日期筛选。换根目录清掉日期筛选。项目组默认折叠，只有会话页指向的会话所在的组展开，有搜索词时命中的组全部展开，每组先显示 8 条。活着的会话在行首用绿点标出，旁边显示它最近用的模型。
- 存活只有一个口径：实体上的 `runtimes`。本进程装配的与其它进程心跳合流后挂在实体上，随清单一起到达，侧栏不另拉接口；`state=live` 只表示「本进程装配过」，不是心跳在跳。心跳先于扫描到达时按心跳里的路径与目录建 `discovered` 占位实体，归属按会话文件落在哪个 home 的 `sessions/` 下判定，随后扫到同一文件由扫描认领；这样别的进程正在用的会话不会因为还没扫到而从清单里缺席。
- 配置页：模型配置（默认模型、思考级别、启用模型、自建 provider 与发现模型）、常规设置（工具/codemode 等非模型项）、skills、subagent、插件、MCP；不提供凭据编辑，凭据由 pi CLI 登录维护，模型测试/发现只读 auth.json。写配置文件带乐观锁与 `.bak-manager` 备份，回显的 apiKey 一律遮蔽。列表型分区统一「左列表 + 右详情 + 底部状态行」骨架（`components/layout.tsx`），分区内容始终在视口内滚动；高度链约定见 `module.css` 头注释。插件分区额外提供内置扩展的一键安装/卸载：复制进 home 的 extensions/，已安装则覆盖，会话列表的运行态功能随之开启。
- 模型配置分区：pi 的模型相关配置收在一个菜单里——默认模型与思考级别（settings 受管 key）、启用模型（enabledModels，含模型目录刷新）、自建 provider（models.json，发现/测试/编辑）。
- 自定义模型的发现模型：从上游 `/models` 拉取后展示可浏览列表（按 id/名称过滤、上游内去重），草稿已有同 id 模型的行打「已存在」标记，其余行逐个「添加」或「添加全部缺失」；草稿 JSON 字符串是唯一真源，保存仍走 models.json 合并写回。
- 选根面板用共享目录浏览器（`@ursi/directory-picker`）：面包屑逐级进入、路径回车直接打开、每目录显示会话数标注。
- 状态栏给出 home 与当前页面的摘要（会话运行态 / 会话数 / 配置）。

### 运行与任务

#### 验收

- 对话上限 `PI_WEB_MAX_CHATS`（默认 8），空闲 30 分钟自动释放并保留文件；进程退出统一释放（abort → dispose → settleCredentialWrites → 删本实例心跳）。
- 一次性任务用同一实体（`kind: 'task'`）：`execution` 记录超时、结果、输出长度与最后助手文本；并发上限 `PI_WEB_MAX_TASKS`（默认 4），超时 `PI_WEB_TASK_TIMEOUT_MS`（默认 600000）。
- pi SDK 未安装时配置与浏览仍可用，对话与任务返回 503。

## 模块结构

- `server/src/server.ts`：入口（配置 → 路由 → 静态 → 信号）。
- `server/src/config.ts`、`state.ts`：唯一读环境变量与状态目录布局的地方。
- `server/src/http/`：路由表（段匹配 + 每条路由声明 home 策略）、响应原语、静态托管。
- `server/src/shared/`：pi home 校验、SDK 按需加载、原子写与乐观锁、JSONC、frontmatter。
- `server/src/config/`：home 注册表、settings / skills / agents / mcp / models / plugins 的文件级读写与路由。
- `server/src/chat/`：常驻对话运行时、会话装配与释放、一次性任务、跨进程心跳读取。
- `server/src/config/builtin-plugins.ts`：内置扩展清单与安装（文件复制，临时文件 + rename 保证原子）；探测规则复用心跳的 `detectPlugin`。
- `server/src/sessions/`：扫描、轨迹转换、偏好、删除、会话实体注册表（`registry.ts`）与路由。
- `web/src/pi-store.ts`：pi home 清单与增删改的唯一真源。
- `web/src/pi-context.tsx`：当前 home 及其派生的 `sessionsRoot`；`pi-nav.tsx`：当前页面与当前目录。
- `web/src/module.tsx`：组合根，Provider 嵌套与 home 变化的跟随；`pi-sidebar.tsx`、`pi-workspace.tsx`、`pi-status.tsx`：侧栏、按页面渲染、状态栏。
- `web/src/composer.tsx`、`session-thread.tsx`、`config-page.tsx`：两种页面与唯一的输入框。
- `web/src/views/{config,sessions,chat}/`：三个子模块的控制器、API 与组件（只做渲染镜像，不互相 import，跨模块走组合根）。
- `web/src/module.css`：引入三份子模块样式与组合根布局 `pi-module.css`，供工作台引入；`standalone.css` 只服务独立入口。
