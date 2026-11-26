---
parent: ../../SPEC.md
references:
  - docs/settings-alignment.md
---

# Pi Manager Web

## 功能意图

pi coding agent 的配置分散在 pi home（默认 `~/.pi/agent`）下的多个文件里：`settings.json`（默认模型、思考级别、默认工具、插件条目）、`skills/`（技能与 frontmatter 开关）、`agents/`（subagent profile 与内置开关）、`mcp.json`（MCP server 条目）、`models.json`（自定义提供商与模型）、`auth.json`（凭据）。pi-web 提供完整会话界面但不做配置编辑；CLI 只能手动改文件。管理台补上这一块：给任意给定的 pi home 一个只做配置管理的页面，页面结构与样式沿用 pi-web Settings 体系，模块形态沿用 dae-web（零依赖 Node 服务托管 React 页面）。

管理台以读写配置文件为主：除下面「执行一次性会话任务」外，不加载扩展、不 spawn MCP server、不执行安装。它与 pi CLI 及 pi-web 共享同一份 pi home，是它们之间的第三入口。凭据永不原样回传浏览器；写操作只对本机开放；文件级乐观锁防止覆盖 pi CLI 的并发修改。

「执行一次性会话任务」是一项明确划界的执行能力：调用方给一个 agent profile 与一句指令，服务端用 pi SDK 在该 home 下起一个会话跑完一轮就结束，不提供交互界面，也不驻留会话。它与 pi-web 的完整交互式 UI 互补：pi-web 是人在用 Pi，这里是程序用 Pi。运行中会话与交互对话是它的两块运行时能力：运行态数据供 [Pi 会话浏览](../pi-sessions-web/SPEC.md) 叠加展示，对话运行时供 [Pi 交互对话](../pi-chat-web/SPEC.md) 使用。

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

- 「常规」分区按 pi 的 settings schema 编辑：默认模型（`defaultProvider` + `defaultModel` 两个独立字符串，一次写入，同时填或同时清空）、默认思考级别（`off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`）、默认工具、codemode（`mode` 为 `on`/`only` 加可选 `inlineBudget`）；写入只触碰受管 key，文件里其余 key 原样保留。
- 内置工具是一组开关（`read`/`grep`/`find`/`ls`/`edit`/`write`/bash）：服务端先按 pi 的规则把 `defaultTools` 解析成实际工具集，再写回最小 `+name`/`-name` 条目；勾选等于 pi 默认组合时删除该 key，扩展工具与未知条目原样保留。原始修饰列表仍可编辑。
- Windows 上提供 PowerShell 代替 bash 的开关，写回普通名字的工具集；非 Windows 请求该接口返回 400。
- 「缓存未命中提示」开关对应 `showCacheMissNotices`：开写 `true`，关删除 key。
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
- Context 与 Max out 可直接覆盖：点击单元格变成数字输入框，回车或失焦提交、Esc 取消，清空即删除该字段的覆盖。写入 `models.json` 的 `providers.<provider>.modelOverrides.<modelId>`，provider 的其余字段与其他模型的覆盖原样保留，被覆盖的行标「已覆盖 <字段>」。
- 覆盖是扩展注册 provider 唯一的元数据配置入口：它们不写任何配置文件，无法用 `models` 重建，只能靠 `modelOverrides` 打补丁（pi 文档明确 `modelOverrides` 作用于内置或扩展提供的模型，且不替换 provider 的模型列表）。
- 覆盖值按 pi 的合并规则取代运行时目录的值，写完立即反映在行内，不必等下一次目录采集。
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

### 配置模型元数据（modelOverrides）

#### 验收

- `PUT /api/models/override` 请求体 `{ provider, modelId, override, revision }`，`override` 为对象或 null（删除该条覆盖）。
- 只触碰 `providers.<provider>.modelOverrides.<modelId>`：该 provider 条目的其它字段、其它模型的覆盖、`models` 列表、文件其它部分都原样保留。最后一条覆盖删掉后连 `modelOverrides` 键一起移除，provider 条目因此变空时整条删除。
- 只写 `modelOverrides` 的 provider 条目是合法的（pi 用扩展或内置定义 provider，这里只覆盖模型），不需要写 baseUrl 或 models。
- 字段校验：`contextWindow`/`maxTokens` 必须是正数，`reasoning` 必须是布尔，`input` 只能是 `text`/`image` 数组；非法的 provider 名或空 modelId 直接 400，不写文件。
- 写入走同一乐观锁（`models.json` 的 revision）与 `.bak-manager` 备份。

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
- 选中 skill 的详情展示根级 frontmatter 原条目（含缩进续行）与正文预览，正文逐字来自 `SKILL.md`，不重新解析 Markdown。
- 仅全局 `skills/` 可写；其他来源只读展示。

### 管理 Subagent

#### 验收

- 「Subagent」分区列出 `agents/` 目录的 subagent 定义（name、description、启用状态）——这些就是会话内 Agent 工具的 `subagent_type` 取值；删除有确认。
- profile 表单按 pi-web 的受管 key 结构化编辑：`display_name`、`model`、`thinking`、`tools`（内置工具勾选加 `ext:` 等扩展工具）、`load_skills`、`load_extensions`、`codemode`（off/inherit/on）、`mcp`（off/on）、`enabled`、`inherit_context`、`run_in_background`、`prompt_mode`、`max_turns`、`color`、`isolation`、`persist_session`，正文是系统提示词。
- 未受管的 frontmatter key 按根级块逐行原样保留（含缩进续行）；`skills:` / `extensions:` 白名单只读展示、保存不改写，开关只写 `load_skills` / `load_extensions`。新增 profile 不为默认值补写多余 key。
- 内置 agent 开关（builtInEnabled、disabledBuiltIns、maxConcurrent）写入 `agents/settings.json`，不触碰主 `settings.json`。
- profile 写入走同一乐观锁与备份机制；项目级 `.pi/agents/` 不在本页范围。

### 管理 MCP 与自定义模型

#### 验收

- 「MCP」分区按 `mcp.json` 的 `mcpServers` 条目列出 server（传输方式摘要），详情以 JSON 编辑，合并写回（保存单条不影响其余，置 null 删除）。
- 字面量密钥回显为掩码，覆盖 env/headers 值、`oauth.clientSecret`、URL 的 userinfo 与查询参数、command 与 args 里 `--token` 这类选项值；`${VAR}` 引用与 `!command` 原样保留并标注，从不展开或执行。
- 遮蔽是可逆的：提交值与“原文的遮蔽形式”一致时写回原文（包括 URL/命令里的局部遮蔽），改成新值则写新值，占位符不会落到磁盘。
- 条目含不可见/控制/零宽字符时，详情标出这些字段的路径。
- 详情给出传输方式、目标（command/url）、cwd、env 与 header 名；`enabled` 与 `exposure` 有独立开关，只改这两个键（`enabled: true` 与 `exposure: codemode` 写回时删键）。
- 「自定义模型」分区按 `models.json` 的 `providers` 条目编辑（baseUrl、api、apiKey、headers、models、modelOverrides），合并写回语义同上；文件为 JSONC 时 UI 提示写回是纯 JSON、注释会丢。
- 保存前拒绝 pi 会丢弃的条目：空对象，以及自带模型却写 `oauth` 不写 `baseUrl` 的自定义 provider；只写 `name` / `api` 的内置覆盖条目放行。非法条目返回 400 且不写盘；`models.json` 读不出时 409 拒绝覆盖，原文件保留。
- provider 详情列出草稿里的模型与 Context / Max out / 推理 / 图片列。
- 「测试连接」用临时 `models.json` 加该 home 的 `auth.json` 起 `ModelRuntime`，对选中模型发一次 16 token 请求（20s 超时，返回耗时与状态）；「从上游拉取」请求 provider 的 `/models` 并把缺失模型追加到草稿，两者都不改磁盘。草稿的 `baseUrl` 与磁盘不同时不携带磁盘凭据，`!command` 凭据直接拒绝测试（管理台不执行命令），掩码形式的 header 不外发。
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

### 提供会话运行态数据

pi 不维护跨进程的会话注册表，运行态只存在于进程内存里。统一约定用一个 pi 扩展把运行态写到 home 目录，管理台用只读接口汇总；页面展示归 [Pi 会话浏览](../pi-sessions-web/SPEC.md)，管理台不再自己画运行中会话面板。

#### 验收

- 扩展源码在 `extension/pi-session-heartbeat.ts`，安装方式是复制或软链到目标 home 的 `extensions/`；已运行的会话需要 `/reload` 或新开会话才加载。
- 每个会话写一个 `<home>/state/running-sessions/<sessionId>.json`，内容含 `sessionId`、`sessionFile`、`parentSessionFile`、`cwd`、`name`、`mode`、`model`、`status`、`startedAt`、`updatedAt`、`host`、`pid`；`status` 只有 `idle` 与 `running`，由 `agent_start` / `agent_settled` 切换。
- `session_start` 写入并每 15 秒续写 `updatedAt`，`session_shutdown` 与进程退出删除本进程写下的文件；写临时文件后原子 rename，权限 0600。
- 同机条目按 pid 判活，进程消失即清；跨机与无法解析的条目按 `updatedAt` 超过 30 分钟清理。读取方可在 60 秒未续写时视为失联，不依赖清扫时机。
- 心跳写入失败只影响心跳，不影响会话；`host` 与 `pid` 让读取方区分同机多进程、同进程多会话与 subagent 子会话。
- `GET /api/session/live?home=<路径>` 只读心跳目录，返回 `sessions`、`heartbeatDir`、`pluginDetected`、`stale`、`now`、`warnings`。超过 60 秒未续写或同机 pid 已退出的条目不进 `sessions`，只计入 `stale`；`running` 排在 `idle` 前，同一状态按最近心跳倒序。
- 心跳目录不存在时返回空清单而不是报错；坏文件与读取失败写进 `warnings` 并跳过，不阻塞其余条目。
- `GET /api/session/live` 不带参数时汇总所有已登记与已发现的 home，返回 `{ sessions, stale, warnings, now }`：会话模块只认会话文件的绝对路径，不需要知道 home 的概念。`?home=` 形式保留给脚本使用。
- 返回值带 `sameHost`、`parentSessionFile`、`mode`、`pid`：判断「本机能不能读文件」「是不是子会话」由采集方算好，展示方不猜。心跳目录不存在时返回空清单而不是报错；坏文件与读取失败写进 `warnings` 并跳过。
- `GET /api/session/disk?home=` 返回该 home 的会话根 `{ root, exists }`，供跨模块跳转使用，前端不自己拼路径。
- `GET /api/session/tasks` 支持 `?home=<绝对路径>` 过滤（保留 `?agent=`），任务分区的「打开轨迹」用它定位会话。
- 运行中会话的展示、轮询与状态点都在会话模块：管理台只负责采集与提供数据，停掉管理台才会话模块少这一层状态。

### 执行交互对话

对话需要一个常驻的 AgentSession：加载某个 pi home 的模型、凭据、skills、subagent 与 MCP，接收事件流、可以连续发消息。运行时归管理台（它已经持有 SDK、home 校验、凭据与并发控制），界面归 [Pi 交互对话](../pi-chat-web/SPEC.md)。

#### 验收

- `server/src/session-runtime.ts` 装配会话：校验 home / cwd / 模型 / thinkingLevel / subagent，续聊只接受落在该 home `sessions/` 下的会话文件（`realpath` 校验），且不接受 cwd 与 subagent（文件里已记录工作目录与工具集）。一次性任务与对话共用这一份装配。
- 释放统一走 `disposeSession()`：abort → `session.dispose()` → `modelRuntime.settleCredentialWrites()` → 删掉本进程写下的心跳文件。直接 `session.dispose()` 不发 `session_shutdown`，心跳扩展删不掉记录，会话模块会看到幽灵 running。
- 新建会话不自建 SessionManager：沿用 `createAgentSession` 的默认布局，会话写进 `<home>/sessions/--<cwd>--/`；只有续聊才 `SessionManager.open(file)`。
- `POST /api/chat/session` 建会话或续聊，返回实际生效的 `model`、`thinkingLevel` 与会话文件；`sessionFile` 由调用方给出时 home 按会话文件反查。同一会话已有运行时则接到已有对话上，不并行追加同一份 JSONL。
- `POST /api/chat/prompt` 在流式期间必须带排队方式（默认 `followUp`，可 `steer`）；`POST /api/chat/abort` 中止并把排队输入原样回传；`POST /api/chat/model` 只切本会话，不写 settings.json；`POST /api/chat/answer` 回执扩展 UI 请求；`POST /api/chat/close` 释放。
- `GET /api/chat/stream?sessionId=` 用 SSE：首帧回放会话行文本（与 pi 会话文件同形状，浏览器用同一个 `parsePiJsonl` 解析），第二帧给 `isStreaming` 与当前 `partial`，随后转发 SDK 事件（`agent_start`、`message_*`、`tool_execution_*`、`queue_update`、`compaction_*`、`auto_retry_*`、`thinking_level_changed`、`agent_settled`）。消息落盘后整段重发 transcript，不依赖 `entry_appended`。
- 扩展 UI 的 `confirm` / `select` / `input` / `notify` 转成帧等浏览器回执，服务端有兜底超时（默认 120 秒）；TUI 专属能力做成静默 stub。
- 对话上限 `PI_MANAGER_MAX_CHATS`（默认 8）超出返回 429；空闲 30 分钟自动释放并保留会话文件；进程收到 SIGINT/SIGTERM 时释放全部对话。重启后按会话文件续聊。
- 路由层支持 handler 接管响应（SSE 与 202），`/api/chat/` 自行解析入参、不参与统一 home 预校验。

### 作为工作台模块接入

管理台同时是独立站点（`App.tsx`）与工作台模块（`module.tsx`），两者共用同一批分区组件与 store。

#### 验收

- `createPiManagerModule({ apiBaseUrl, storageKey, openRootInSessions? })` 返回 `WorkspaceModule`：侧边栏是 pi home 清单 + 分区导航，工作区是分区内容；分区状态的 localStorage 键以 `storageKey` 为前缀。
- 发布 `context.kind = 'pi.home'`：store 里的 homePath 是真源，选中单向派生，只在 home 真的变化时发布，不抢别的模块的选中。
- 样式分两份：独立入口用 `styles.css`；模块入口用 `module.css`（由 `scripts/scope-css.py` 从 `styles.css` 生成，全部选择器挂在 `.pi-manager-root` 下，不下发 `html/body/#root` 与全局 reset）。
- `openRootInSessions` 注入时提供动作「在会话模块打开该 home 的会话」：先 `GET /api/session/disk` 取会话根，再 `shell.reveal('pi-sessions')`；会话模块未启用时给出禁用原因。
- 已废弃 `SessionsPanel`：运行中会话的展示在会话模块里。

### 安全边界

#### 验收

- 服务不区分来源：读写接口都接受任意客户端，安全边界由部署环境（可信局域网）承担，不做应用层鉴权。
- 每次写入前把原文件备份为 `<name>.bak-manager`（避开 pi 自身的 `.bak_*` 系列），写入临时文件与目标同目录后原子 rename，文件模式 0600。
- 服务监听 `0.0.0.0:8093`（`PI_MANAGER_PORT` 可覆盖），`/healthz` 暴露状态与写策略（`trusted-lan`）。
- 凭据原文仍不外传：读接口一律遮蔽，只在提交瞬间经请求体传输。
- 采集运行时目录是本页唯一会执行该 home 扩展代码的操作（provider 扩展访问网关取模型列表），因此只在显式刷新时发生，且用内存设置与内存会话，不改写该 home 的任何配置文件、不安装包、不建会话。

## 模块结构

- `server/src/`：零依赖 Node http 服务。`pi-home.ts` 校验与解析 home；`homes.ts` 持有 pi home 清单（注册表、落盘、初始化与复制）、自动发现与轻量摘要；`rw.ts` 提供乐观锁、原子写、备份原语；`jsonc.ts` 处理 BOM 与注释；`frontmatter.ts` 按根级块解析与渲染 agent/skill 的 frontmatter；各域模块（`settings-file`、`tool-settings`、`skills`、`agents`、`models-auth`、`plugins`、`mcp-file`、`mcp-mask`）只做文件级读写；`models-check.ts` 镜像 pi 会拒绝的 provider 条目规则；`sdk.ts` 按需加载 pi SDK（缺失时 503，不影响配置管理）；`models-runtime.ts` 用内存会话采集真实模型目录并按 home 缓存；`models-probe.ts` 做连接测试与上游模型发现；`models-auth.ts` 另负责 `modelOverrides` 的读写；`session-runtime.ts` 是任务与对话共用的会话装配、会话文件归属校验与释放；`session-task.ts` 用 pi SDK 执行一次性会话任务（任务表、并发与超时上限）；`chat.ts` 是交互对话运行时（会话表、SSE、扩展 UI 桥接、限流与空闲回收）；`live-sessions.ts` 读取心跳文件并过滤失联条目；`api.ts` 路由；`core.test.ts` 用 node --test 覆盖解析、遮蔽、外科切换、合并写回、frontmatter 往返与心跳过滤。
- `extension/`：`pi-session-heartbeat.ts` 是安装到 pi home 的扩展，负责写会话心跳文件；`README.md` 记录安装方式与文件约定。
- `web/src/`：React 19 + Vite + zustand。`api/client.ts` 薄封装（可注入接口前缀，导出 `createApiClient` 给别的模块用）；`module.tsx` 是工作台模块入口；`store/app-store.ts` 管 home、预设登记与页脚消息；`components/` 下 HomeBar、Sidebar 与七个分区组件；分区组件是表格列表 + 底部详情面板，已挂载分区保持状态，`sections/ScopedModelsPanel.tsx` 是启用模型列表（按 provider 分组、组内开关与排序、组级开关、模式输入），`sections/AgentsSection.tsx` 是结构化 profile 表单，`sections/McpSection.tsx` 与 `sections/ModelsSection.tsx` 的详情分别带 MCP 开关/摘要与模型测试/发现；`styles.css` 采用与 `apps/todo-web` 一致的黑白灰出版物式版面：mono 正文配 serif 小标题、直角按钮、方块开关、选中行内阴影与左侧竖线、底部 sheet 上滑动画；`module.css` 是它的作用域化版本（`scripts/scope-css.py` 生成）。
