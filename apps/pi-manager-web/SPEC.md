---
parent: ../../SPEC.md
---

# Pi Manager Web

## 功能意图

pi coding agent 的配置分散在 pi home（默认 `~/.pi/agent`）下的多个文件里：`settings.json`（默认模型、思考级别、默认工具、插件条目）、`skills/`（技能与 frontmatter 开关）、`agents/`（subagent profile 与内置开关）、`mcp.json`（MCP server 条目）、`models.json`（自定义提供商与模型）、`auth.json`（凭据）。pi-web 提供完整会话界面但不做配置编辑；CLI 只能手动改文件。管理台补上这一块：给任意给定的 pi home 一个只做配置管理的页面，页面结构与样式沿用 pi-web Settings 体系，模块形态沿用 dae-web（零依赖 Node 服务托管 React 页面）。

管理台以读写配置文件为主：除下面「执行一次性会话任务」外，不加载扩展、不 spawn MCP server、不执行安装。它与 pi CLI 及 pi-web 共享同一份 pi home，是它们之间的第三入口。凭据永不原样回传浏览器；写操作只对本机开放；文件级乐观锁防止覆盖 pi CLI 的并发修改。

「执行一次性会话任务」是一项明确划界的执行能力：调用方给一个 agent profile 与一句指令，服务端用 pi SDK 在该 home 下起一个会话跑完一轮就结束，不提供交互界面，也不驻留会话。它与 pi-web 的完整交互式 UI 互补：pi-web 是人在用 Pi，这里是程序用 Pi。

## 关键功能与验收

### 指定并切换 pi home

#### 验收

- 首次打开自动探测默认 pi home；顶栏显示当前 home 的名称与路径，切换与新增统一在左侧「Pi home」列表完成。
- 左侧「Pi home」分组列出 pi home 清单与自动发现项：清单由服务端持有并原子落盘（`$XDG_STATE_HOME/pi-manager-web/homes.json`，`PI_MANAGER_STATE` 可覆盖），首次启动用默认位置（`~/.pi/agent`）与 `PI_CODING_AGENT_DIR` 播种；`/home/*/.pi/agent` 等未登记项作为只读候选列出，标来源「本机」并带「+」一键登记。条目 id 取 realpath 的 sha256 前 16 位，跨重启稳定。
- 每条显示自定义名称、完整路径与内容摘要（skill / agent / mcp / 插件数量）；左键切换，右键弹出菜单：重命名、编辑说明、从清单移除（先弹确认菜单，只动清单不删文件）。未登记的自动发现项右键只有「登记到清单」。菜单点空白、按 Esc、滚动或改变窗口大小时关闭。
- 分组标题右侧「+」展开新增面板，三选一：**初始化**（新建目录，生成 `settings.json` 与空的 `skills/`、`agents/`）、**复制**（从另一份 home 复制 `settings.json`/`models.json`/`mcp.json` 与 `skills`、`agents`、`prompts`、`themes` 目录，默认不带 `auth.json` 凭据，也不带 sessions/npm 等运行态）、**登记**（目录必须已是 pi home）。可同时指定显示名称，留空取目录名。
- 新增只创建最后一级目录：上级目录不存在时报错，不静默生成目录链；目标已存在且非空返回 409。
- 点击条目即切换该 home 并重新加载全部分区；当前项高亮，失效条目标红并说明缺失项。当前 home 失效时侧边栏仍可用，内容区提示从列表另选或新增。「↻」重新扫描。
- 目录缺 `settings.json`（realpath 校验）时明确提示"不是有效的 pi home"，分区不加载；路径错误不写脏数据。
- 切换 home 后整个内容区强制重挂载，所有分区状态重置；选中的 home 持久化在 localStorage，下次打开自动恢复。
- 服务端不持有全局 home 状态，每个请求携带 `?home=` 参数并逐次 realpath 校验。

### 编辑 settings.json 受管项

#### 验收

- 「常规」分区按 pi 的 settings schema 编辑：默认模型（`defaultProvider` + `defaultModel` 两个独立字符串，一次写入，同时填或同时清空）、默认思考级别（`off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`）、默认工具（`+name`/`-name` 修饰列表）、codemode（`mode` 为 `on`/`only` 加可选 `inlineBudget`）；写入只触碰受管 key，文件里其余 key 原样保留。
- 默认模型输入框按「已知模型清单」补全：清单合并 `enabledModels`、`models.json` 自建 provider 与 `models-store.json` 的运行目录，由 `GET /api/models/catalog` 提供。
- 写 `settings.json` 用 2 空格缩进、不带结尾换行，与 pi 自身的写法一致，避免互相改写产生无意义 diff。
- 「插件」分区列出 `packages` 条目与 `npm/` 安装目录核对结果；string 条目禁用编码为四空数组 object，启用还原；带资源过滤列表（extensions/skills/prompts/themes 非空）的条目拒绝禁用并解释原因；移除条目不删 `npm/` 目录。
- 每次写入带乐观锁（revision = mtimeMs.size）；文件被其他进程修改后写入返回 409 并提示刷新，原文件保留。

### 启用模型列表（enabledModels）

对齐 pi TUI 的 `/scoped-models`：`enabledModels` 决定模型循环与启动选择，顺序有实义。

#### 验收

- 「常规」分区下半部是全宽的启用模型列表，按 provider 分组：组头显示 provider 名、已启用数 / 总数、启动首选标记与整组开关，可逐组展开收起，并提供「展开全部 / 收起全部」。组头 title 列出该组已启用的模型，收起时也能读到。
- 默认只展开第一个有启用项的 provider，其余收起；用户手动点过之后按用户选择，不被数据刷新覆盖。
- 组内模型区限高（`min(46vh, 420px)`）内部滚动、表头 sticky。一个 provider 有几十个模型时也只占一屏，不会把其他 provider 组头挤出视野。页面不依赖整体长滚动。
- 过滤有两个入口：模型名输入框与 provider 下拉；任一过滤生效时命中组自动展开。
- 组内逐条开关、序号列、上下移按钮，行内标注来源与显示名；底部「添加并启用」接受 `provider/modelId` 或匹配模式。
- 模型行展示运行时能力：Context（上下文窗口）、Max out（单次输出上限）、能力（思考 / 图片）、显示名与来源。换算口径对齐 `pi --list-models`（200K / 1M）。未知显示 `—`。
- 候选集合在采集过运行时目录后等于「pi 的 `/model` 选择器可见模型」（provider 有可用凭据的那批），这就是唯一包含 `extensions/providers/` 注册 provider 的来源；未采集时退回 `models.json` 与 `models-store.json` 的文件级候选。
- 大小写不同的同一模型合并成一行：`provider/id` 按小写比对，启用项沿用 `settings.json` 里的原始写法，写回不改大小写。
- provider 整组开关对齐 pi 的 `toggleProvider`：组内全部已启用则整组停用，否则补齐组内全部模型。只能靠已启用项可见的 provider（扩展注册、文件目录里没有模型）无法整组启用，页面提示手写 `provider/modelId` 或模式。
- 顺序即 `Ctrl+P` 循环顺序，第一条启用项是新会话的启动首选，页面在该行标注「启动首选」；未限定清单时提示 pi 用默认模型。
- 候选行为 `enabledModels` 已启用项与磁盘上可见模型（`models.json`、`models-store.json`、默认模型）的并集，每行标注来源；`*`/`?`/`[` 通配条目标为模式。已启用但磁盘目录里没有的（例如 `extensions/providers/` 注册的 provider）保留并标注「文件目录里没有，由扩展或网关提供」，不静默丢弃。
- 工具条按钮跟随状态切换：「全部启用」写为删除 `enabledModels` key（pi 语义：key 不存在等于全部可用），「全部停用」写为空数组，两者互为反选。
- `enabledModels` 的三种形态在接口里显式区分（`scope`）：`all` = key 不存在，所有候选按启用显示、无序号；`none` = 空数组，所有候选关闭；`explicit` = 非空清单，按清单顺序给序号。页面按形态显示状态与按钮。
- 全部可用状态下单条或整组关掉，会把其余候选落成显式清单，与 pi 的 `toggle(null)` 行为一致。
- 空数组在 pi 侧会被 `/scoped-models` 归一成「全部可用」，因此「全部停用」只在 `settings.json` 层面保留，页面明确写出这一限制，不假装是持久生效的状态。
- 每次改动都通过 `PUT /api/general/key` 带 revision 写回，只改 `enabledModels` 一个 key。

### 采集运行时模型目录

`contextWindow` / `maxTokens` / 思考与图片能力只存在于 pi 的 ModelRuntime：内置目录来自 pi 的 catalog 缓存，自建 provider 来自 `models.json`，而扩展注册的 provider 不落任何配置文件。因此这几列要靠一次真实采集。

#### 验收

- `GET /api/models/catalog` 只读缓存。缓存按「home + cwd」分键存在状态目录的 `model-catalog/<hash>.json`，`PI_MANAGER_STATE` 的目录部分参与定位。
- `POST /api/models/catalog/refresh` 执行采集：加载该 home 的扩展（provider 扩展访问网关），用内存会话枚举 `getAvailableSnapshot()`（provider 已有可用凭据的模型），写入缓存后返回完整 catalog。
- 页面首次打开发现 `catalogFetchedAt` 为 null 时自动采集一次；之后只在用户点「刷新模型目录」时重新采集，并显示「采集于 N 分钟前 / 覆盖 M 个 provider」。
- 采集用 `SettingsManager.inMemory({})` 与 `SessionManager.inMemory()`：不改写该 home 的 `settings.json`，不触发 `packages` 的 npm 安装，不写 `sessions/`，不 spawn MCP server（工具全关）。
- SDK 未安装时刷新返回 503，配置管理其余部分与已有缓存照常可用。
- 采集结果里的模型以 `runtime` 来源标出；已启用但目录里找不到的条目保留并标注「目录里没有，由扩展或网关提供」。

### 管理 Skills

#### 验收

- 列出 pi home `skills/` 目录全部 skill（name、description、所在子目录），支持按名称与描述过滤；子目录读取失败单独标注，不阻塞其余条目。
- 单个 skill 的 `disable-model-invocation` 开关以 frontmatter 行级切换写回：启用/禁用只增删或修改该行，正文逐字节不变，CRLF/LF 保持；改动前备份 `SKILL.md.bak-manager`。
- 仅全局 `skills/` 可写；其他来源只读展示。

### 管理 Subagent

#### 验收

- 「Subagent」分区列出 `agents/` 目录的 subagent 定义（name、description、扩展 frontmatter key、正文预览）——这些就是会话内 Agent 工具的 `subagent_type` 取值；表单编辑保存为 `agents/<name>.md`，未知 frontmatter key 原样保留；删除有确认。
- 内置 agent 开关（builtInEnabled、disabledBuiltIns、maxConcurrent）写入 `agents/settings.json`，不触碰主 `settings.json`。
- profile 写入走同一乐观锁与备份机制；项目级 `.pi/agents/` 不在本页范围。

### 管理 MCP 与自定义模型

#### 验收

- 「MCP」分区按 `mcp.json` 的 `mcpServers` 条目列出 server（传输方式摘要），详情以 JSON 编辑，合并写回（保存单条不影响其余，置 null 删除）。
- env/headers 里的字面量密钥回显为掩码（名字含凭据词或值是 `Bearer <token>` 短语）；原样提交掩码时服务端还原为原文，改成新值则写新值；`${VAR}` 引用标注后原样保留；`!command` 值标注警示且从不执行。
- 「自定义模型」分区按 `models.json` 的 `providers` 条目编辑（baseUrl、apiKey、models 数组），合并写回语义同上；文件为 JSONC 时 UI 提示写回是纯 JSON、注释会丢。
- 分区底部只读展示模型来源汇总：当前默认模型、`enabledModels` 条数、`models.json` 自建 provider 数，以及 `models-store.json` 缓存的内置 provider 目录（provider 名与模型数）。`models-store.json` 只读展示，不参与写回；由 `extensions/providers/` 注册的 provider 不写任何配置文件，页面明确说明管理台按文件管理、不加载扩展。
- 首次保存创建文件（含 `mcpServers`/`providers` 包裹层）；运行状态与工具发现由 pi 会话负责，管理台不 spawn。

### 管理凭据

#### 验收

- 「凭据」分区按 `auth.json` 条目列出 provider、类型（api_key / oauth / 未知）与凭据摘要；oauth 显示过期时间并标注是否已过期，`!command` 形式的 key 标注为从命令取密钥。
- 选中条目后以 JSON 编辑完整条目并保存：`key`/`access`/`refresh` 回显为掩码（末 4 位），原样保存即保留磁盘原文，改成新值则写新值；api_key 的 `env` 等其余字段可直接改。
- 新增条目按 api_key 或 oauth 模板创建；删除条目有确认。合并写回只改提交的 provider，其余条目原样保留，原文件备份 `auth.json.bak-manager`，写入模式 0600。
- 乐观锁：`auth.json` 被 pi CLI 等进程改过后写入返回 409，原文件不变。
- 凭据原文任何接口都不返回，只在提交瞬间经请求体传输。

### 执行一次性会话任务

按 agent profile 在指定 pi home 下跑一轮会话，返回 session id 供后续查询。

#### 验收

- 两层身份不要混淆。**agent 就是一份 pi home**：它自带模型、凭据、skills、subagent 定义与 MCP 设置，因此不同 home 里的同名 subagent 属于不同 agent；清单里的 `name` 是 agent 名且必须唯一（不区分大小写查重），改名时同样校验。
- **subagent 是 `agents/*.md` 定义的一种「特别的工具」**：会话里的 Agent 工具按 `subagent_type` 派生一个子会话，profile 文件就是该取值的定义——正文是子会话的系统提示，frontmatter 约束工具集（`tools`）、模型（`model`）与思考级别（`thinking`）。它不是可选人设，而是工具的参数枚举。
- `POST /api/session/prompt` 请求体 `{ agent, instruct, subagent?, cwd?, model?, thinkingLevel? }`，返回 `{ sessionId, sessionFile, state, agent, subagent, startedAt }`。`agent` 填 pi home 的 `name`（也接受清单 `id` 与绝对路径，便于脚本）；接口不需要 `home` 参数。
- 可选的 `subagent` 表示「直接以该 subagent 的定义起一个会话」，等价于父会话调用一次 Agent 工具：解析该 home 的 `agents/<name>.md`（按文件名或 frontmatter 的 `name` 匹配，不区分大小写），正文作为系统提示，`tools` 作为该会话的工具集。省略则起普通主会话，由它自己决定是否派生 subagent。
- 会话用该 agent（home）的模型、凭据、skills、agents 设置；`cwd` 决定工具与项目级资源发现，省略时用服务进程当前目录。会话按 pi 的默认分组规则写入 `<home>/sessions/--<cwd>--/`，pi CLI 与 pi-web 能看到并接着聊。
- 会话创建在接口返回前完成，因此 agent 不存在（404）、subagent 不存在（404）、模型不存在（404）、`instruct` 为空（400）、`thinkingLevel` 非法（400）、`cwd` 不存在（404）都直接报给调用方；`prompt` 本身在后台执行。
- 执行会在该 home 下留下 pi 自己的运行产物：`sessions/` 里的会话文件，以及 SDK 首次运行初始化的空 `auth.json`、`models-store.json`（与 pi CLI 行为一致）。管理台不额外写入配置。
- `GET /api/session/task?sessionId=<id>` 返回该任务状态（`running` / `done` / `error` / `cancelled`）、agent 与 subagent、最后一条助手文本、错误说明与累计输出长度；`GET /api/session/tasks` 列出全部任务，`?agent=<name>` 按 agent 过滤；`POST /api/session/cancel` 中止运行中的任务。
- 同时运行的会话数受上限约束（默认 4，`PI_MANAGER_MAX_TASKS` 可调），超出返回 429；单次任务有超时（默认 600000 ms，`PI_MANAGER_TASK_TIMEOUT_MS` 可调），超时即中止并标记失败。
- pi SDK 按需加载：未安装 `@earendil-works/pi-coding-agent` 时配置管理功能照常可用，执行接口返回 503。

### 安全边界

#### 验收

- 服务不区分来源：读写接口都接受任意客户端，安全边界由部署环境（可信局域网）承担，不做应用层鉴权。
- 每次写入前把原文件备份为 `<name>.bak-manager`（避开 pi 自身的 `.bak_*` 系列），写入临时文件与目标同目录后原子 rename，文件模式 0600。
- 服务监听 `0.0.0.0:8093`（`PI_MANAGER_PORT` 可覆盖），`/healthz` 暴露状态与写策略（`trusted-lan`）。
- 凭据原文仍不外传：读接口一律遮蔽，只在提交瞬间经请求体传输。
- 采集运行时目录是本页唯一会执行该 home 扩展代码的操作（provider 扩展访问网关取模型列表），因此只在显式刷新时发生，且用内存设置与内存会话，不改写该 home 的任何配置文件、不安装包、不建会话。

## 模块结构

- `server/src/`：零依赖 Node http 服务。`pi-home.ts` 校验与解析 home；`homes.ts` 持有 pi home 清单（注册表、落盘、初始化与复制）、自动发现与轻量摘要；`rw.ts` 提供乐观锁、原子写、备份原语；`jsonc.ts` 处理 BOM 与注释；各域模块（`settings-file`、`skills`、`agents`、`models-auth`、`plugins`）只做文件级读写；`sdk.ts` 按需加载 pi SDK（缺失时 503，不影响配置管理）；`models-runtime.ts` 用内存会话采集真实模型目录并按 home 缓存；`session-task.ts` 用 pi SDK 执行一次性会话任务（任务表、并发与超时上限）；`api.ts` 路由；`core.test.ts` 用 node --test 覆盖解析、遮蔽、外科切换与合并写回。
- `web/src/`：React 19 + Vite + zustand。`api/client.ts` 薄封装；`store/app-store.ts` 管 home、预设登记与页脚消息；`components/` 下 HomeBar、Sidebar 与七个分区组件（表格列表 + 底部详情面板，已挂载分区保持状态），`sections/ScopedModelsPanel.tsx` 是启用模型列表（按 provider 分组、组内开关与排序、组级开关、模式输入）；`styles.css` 采用与 `apps/todo-web` 一致的黑白灰出版物式版面：mono 正文配 serif 小标题、直角按钮、方块开关、选中行内阴影与左侧竖线、底部 sheet 上滑动画。
