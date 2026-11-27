---
parent: ../../SPEC.md
references:
  - HTTP.md
  - ../../docs/design/pi-web/OVERVIEW.md
  - ../../packages/workspace-shell/MODULE-CONTRACT.md
---

# Pi Web

## 功能意图

pi coding agent 的浏览器端：配置、对话、会话浏览三件事操作同一套领域模型。

一份 pi home 决定整套能力（模型、凭据、skills、agents、MCP、工具策略），因此 home 是全应用唯一的上下文轴：配置写它的注册表字段，对话用它装配运行时，会话浏览的默认根是 `<home>/sessions`。

会话只有一个身份 `sessionId`（会话头 `SessionHeader.id`）。磁盘上的历史文件、内存里加载的会话、正在收发的对话、一次性任务、子会话，都是同一个 `PiSession` 实体的不同状态投影；运行态（本进程与其它进程的心跳）挂在实体的 `runtimes` 上，不再有独立的运行态接口。

交付形态：

- `server/`：一个零依赖 Node 24 进程，托管 `/api/*` 与独立页面；pi SDK 按需加载。
- `web/`：一个工作区模块 `pi`，侧栏三段切换（对话 / 会话 / 配置），三个视图只是同一份实体的不同投影。
- 数据与状态：`$URSI_HOME/pi-web`（home 清单、扫描索引、特别关注、模型目录缓存）；会话文件仍写在各自 pi home 的 `sessions/`。

边界：不做多用户与鉴权（部署在可信局域网，入口防护由前置层承担）；不做终端、文件浏览、附件与图片输入；不改写别人的会话内容（唯一写操作是删除会话文件与记录特别关注）。

## 关键功能与验收

### pi home 实体

#### 验收

- `GET /api/homes` 的每条记录都带 `sessionsRoot`、`profileRevision` 与 `capabilities`（skill / agent / mcp / 插件数量、默认模型、是否有可用凭据），前端不自己拼路径或统计。
- home 清单原子落盘到 `$PI_WEB_STATE/homes.json`；条目 id 是 realpath 的 sha256 前 16 位，跨重启稳定。
- 创建支持初始化、复制、登记三种模式，只创建最后一级目录，目标已存在且非空返回 409。
- `GET /api/homes/:id/runtime-profile` 返回服务端解析好的模型候选（`enabledModels` 范围、provider 与显示名、支持的思考档位与映射）、subagent 清单、默认 cwd 与会话根；前端不重算匹配规则。
- 配置写入返回新的 `profileRevision`；该 home 下已加载的会话据此标记 `stale`。

### 会话实体

#### 验收

- 会话 id 取会话头 `id`；服务端创建时用 uuidv7 铸造并经 `SessionManager.create(cwd, dir, { id })` 写入文件头，内存态与磁盘态同键。
- 无头部老文件按 `(filePath, 首行内容)` 哈希派生 id，`identitySource = 'derived'`，不改写磁盘；这类会话只读（`canRun=false`，原因码 `legacy_without_header`）。
- `GET /api/sessions` 支持 `home`（home 路径或 id）与 `root`（任意绝对目录）两种作用域，返回同一份实体；带 `since` 时未变化回 `notModified`，变化回完整列表（epoch 不匹配时要求整份重取）。
- 外部目录按 LRU 维护（默认 4 个）并带空闲 TTL（默认 30 分钟），过期即移出扫描目标，其下 `discovered` 实体被移除，文件不动。
- 状态机：`discovered → loading → ready ⇄ running`，旁支 `failed`，`evicted` 回流 `discovered`，`deleted` 终态。`loading` 与 `running` 的删改分别返回 409 `session_loading` / `session_busy`。
- 同一 `sessionId` 的装配单飞：并发「继续」拿到同一个运行时，不出现并行追加同一份 JSONL。
- 上游 `sessionFile` 不再是跨接口的键：删除只按实体定位，客户端不传路径。

### 轨迹

#### 验收

- `GET /api/sessions/:id/trajectory` 返回该会话唯一的轨迹：首行补齐 `type: "session"`、老写法映射成 `message` 行、坏行丢弃并计数；这是会话视图与对话视图共用的同一份权威。
- 文件存在本地运行时且已落盘内容时以运行时为准，其它情况以文件为准；接口形态一致。
- 体积超过上限返回 413 与中文说明；支持 gzip 协商。
- 事件流 `GET /api/sessions/:id/events` 只对存在本地运行时的会话开放，帧带 `revision`，重连按 `since` 续接。

### 三个视图

#### 验收

- 侧栏顶部是视图切换（对话 / 会话 / 配置），下面是当前视图自己的侧栏；切换视图不重建其他视图的实体状态。
- 视图首次激活才挂载：打开工作台不会立刻扫描目录或连接事件流。
- home 只有一份真源：任一视图里切 home，其余视图跟随；会话视图的根默认取该 home 的 `sessions/`，用户显式改成任意目录即进入外部目录浏览（不改 home）。
- 对话视图：建会话/续聊、流式输出、工具调用可见、可打断、排队数与扩展 UI 回执；会话内换模型只影响本会话。
- 会话视图：按项目分组、日期条、搜索、特别关注、删除、查看轨迹；进入时能续聊同一实体（不新建会话）。运行态（绿点、运行中计数）以心跳插件是否检测到为总开关：未检测到时不显示运行态，在侧栏给出安装引导；检测到后自动开启。
- 配置视图：模型配置（默认模型、思考级别、启用模型、自建 provider 与发现模型）、常规设置（工具/codemode 等非模型项）、skills、subagent、插件、MCP；不提供凭据编辑，凭据由 pi CLI 登录维护，模型测试/发现只读 auth.json。写配置文件带乐观锁与 `.bak-manager` 备份，回显的 apiKey 一律遮蔽。列表型分区统一「左列表 + 右详情 + 底部状态行」骨架（`components/layout.tsx`），分区内容始终在视口内滚动，滚动条保持隐藏风格；高度链约定见 `module.css` 头注释（main → config-section-host → 滚动层，中间层不得断开）。插件分区额外提供内置扩展（随本服务自带的 extension/ 文件）的一键安装/卸载：复制进 home 的 extensions/，已安装则覆盖，会话视图的运行态功能随之开启。
- 模型配置分区：pi 的模型相关配置收在一个菜单里——默认模型与思考级别（settings 受管 key）、启用模型（enabledModels，含模型目录刷新）、自建 provider（models.json，发现/测试/编辑）。
- 自定义模型的发现模型：从上游 `/models` 拉取后展示可浏览列表（按 id/名称过滤、上游内去重），草稿已有同 id 模型的行打「已存在」标记，其余行逐个「添加」或「添加全部缺失」；草稿 JSON 字符串是唯一真源，保存仍走 models.json 合并写回。
- 视图之间的跳转是模块内切换：「看完整轨迹」切到会话视图并选中同一份会话文件，「在对话里继续」切到对话视图并在同一实体上续聊；都走同一份实体，不复制文件。
- 侧栏折叠成 32px 窄条时只显示当前视图与 home，不渲染三段切换；展开由外壳的折叠控制驱动。
- 状态栏按活动视图给出摘要（对话运行态 / 会话数与选中项 / 当前 home）。

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
- `web/src/pi-context.tsx`：home 与视图的唯一真源。
- `web/src/pi-sidebar.tsx`、`pi-workspace.tsx`、`pi-status.tsx`：三段切换、按视图渲染、状态栏。
- `web/src/views/{config,sessions,chat}/`：三个视图各自的侧栏、工作区与状态（只做渲染镜像）。
- `web/src/module.css`：三段视图样式与切换条，供工作台引入；`standalone.css` 只服务独立入口。
