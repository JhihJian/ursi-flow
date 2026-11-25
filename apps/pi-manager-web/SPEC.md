---
parent: ../../SPEC.md
---

# Pi Manager Web

## 功能意图

pi coding agent 的配置分散在 pi home（默认 `~/.pi/agent`）下的多个文件里：`settings.json`（默认模型、思考级别、默认工具、插件条目）、`skills/`（技能与 frontmatter 开关）、`agents/`（subagent profile 与内置开关）、`mcp.json`（MCP server 条目）、`models.json`（自定义提供商与模型）、`auth.json`（凭据）。pi-web 提供完整会话界面但不做配置编辑；CLI 只能手动改文件。管理台补上这一块：给任意给定的 pi home 一个只做配置管理的页面，页面结构与样式沿用 pi-web Settings 体系，模块形态沿用 dae-web（零依赖 Node 服务托管 React 页面）。

管理台不运行 AgentSession、不加载扩展、不 spawn MCP server、不执行安装。它只读写配置文件，与 pi CLI 及 pi-web 共享同一份 pi home，是它们之间的第三入口。凭据永不原样回传浏览器；写操作只对本机开放；文件级乐观锁防止覆盖 pi CLI 的并发修改。

## 关键功能与验收

### 指定并切换 pi home

#### 验收

- 首次打开自动探测默认 pi home；顶栏显示当前路径，「切换 home」输入绝对路径后即时校验。
- 左侧「Pi 预设」分组列出所有已知 pi home：默认位置（`~/.pi/agent`）、`PI_CODING_AGENT_DIR` 指定的位置、同机其他用户的 `/home/*/.pi/agent`，以及用户自己登记的预设。每条显示短名、来源标记与内容摘要（skill / agent / mcp / 插件数量）。
- 点击条目即切换该 home 并重新加载全部分区；当前项高亮，失效目录标红并说明缺失项。「+」把当前路径登记为预设（存 localStorage），已登记的预设可「×」移除，目录本身不受影响。
- 目录缺 `settings.json`（realpath 校验）时明确提示"不是有效的 pi home"，分区不加载；路径错误不写脏数据。
- 切换 home 后整个内容区强制重挂载，所有分区状态重置；选中的 home 持久化在 localStorage，下次打开自动恢复。
- 服务端不持有全局 home 状态，每个请求携带 `?home=` 参数并逐次 realpath 校验。

### 编辑 settings.json 受管项

#### 验收

- 「常规」分区编辑默认模型（provider/modelId）、默认思考级别、默认工具（`+name`/`-name` 修饰列表）与 codemode 开关；写入只触碰受管 key，文件里其余 key 原样保留。
- 「插件」分区列出 `packages` 条目与 `npm/` 安装目录核对结果；string 条目禁用编码为四空数组 object，启用还原；带资源过滤列表（extensions/skills/prompts/themes 非空）的条目拒绝禁用并解释原因；移除条目不删 `npm/` 目录。
- 每次写入带乐观锁（revision = mtimeMs.size）；文件被其他进程修改后写入返回 409 并提示刷新，原文件保留。

### 管理 Skills

#### 验收

- 列出 pi home `skills/` 目录全部 skill（name、description、所在子目录），支持按名称与描述过滤；子目录读取失败单独标注，不阻塞其余条目。
- 单个 skill 的 `disable-model-invocation` 开关以 frontmatter 行级切换写回：启用/禁用只增删或修改该行，正文逐字节不变，CRLF/LF 保持；改动前备份 `SKILL.md.bak-manager`。
- 仅全局 `skills/` 可写；其他来源只读展示。

### 管理 Subagent

#### 验收

- 「Subagent」分区列出 `agents/` 目录 profile（name、description、扩展 frontmatter key、正文预览）；表单编辑保存为 `agents/<name>.md`，未知 frontmatter key 原样保留；删除有确认。
- 内置 agent 开关（builtInEnabled、disabledBuiltIns、maxConcurrent）写入 `agents/settings.json`，不触碰主 `settings.json`。
- profile 写入走同一乐观锁与备份机制；项目级 `.pi/agents/` 不在本页范围。

### 管理 MCP 与自定义模型

#### 验收

- 「MCP」分区按 `mcp.json` 的 `mcpServers` 条目列出 server（传输方式摘要），详情以 JSON 编辑，合并写回（保存单条不影响其余，置 null 删除）。
- env/headers 里的字面量密钥回显为掩码（名字含凭据词或值是 `Bearer <token>` 短语）；原样提交掩码时服务端还原为原文，改成新值则写新值；`${VAR}` 引用标注后原样保留；`!command` 值标注警示且从不执行。
- 「自定义模型」分区按 `models.json` 的 `providers` 条目编辑（baseUrl、apiKey、models 数组），合并写回语义同上；文件为 JSONC 时 UI 提示写回是纯 JSON、注释会丢。
- 首次保存创建文件（含 `mcpServers`/`providers` 包裹层）；运行状态与工具发现由 pi 会话负责，管理台不 spawn。

### 管理凭据

#### 验收

- 「凭据」分区按 `auth.json` 条目列出 provider、类型（api_key / oauth / 未知）与凭据摘要；oauth 显示过期时间并标注是否已过期，`!command` 形式的 key 标注为从命令取密钥。
- 选中条目后以 JSON 编辑完整条目并保存：`key`/`access`/`refresh` 回显为掩码（末 4 位），原样保存即保留磁盘原文，改成新值则写新值；api_key 的 `env` 等其余字段可直接改。
- 新增条目按 api_key 或 oauth 模板创建；删除条目有确认。合并写回只改提交的 provider，其余条目原样保留，原文件备份 `auth.json.bak-manager`，写入模式 0600。
- 乐观锁：`auth.json` 被 pi CLI 等进程改过后写入返回 409，原文件不变。
- 凭据原文任何接口都不返回，只在提交瞬间经请求体传输。

### 安全边界

#### 验收

- 读接口任意来源可访问（凭据字段已遮蔽）；所有写接口只接受回环来源，非回环返回 403 `read_only`。
- 每次写入前把原文件备份为 `<name>.bak-manager`（避开 pi 自身的 `.bak_*` 系列），写入临时文件与目标同目录后原子 rename，文件模式 0600。
- 服务监听 `0.0.0.0:8093`（`PI_MANAGER_PORT` 可覆盖），`/healthz` 暴露状态与写策略。

## 模块结构

- `server/src/`：零依赖 Node http 服务。`pi-home.ts` 校验与解析 home；`homes.ts` 发现已知 pi home 并生成轻量摘要；`rw.ts` 提供乐观锁、原子写、备份原语；`jsonc.ts` 处理 BOM 与注释；各域模块（`settings-file`、`skills`、`agents`、`mcp-file`、`models-auth`、`plugins`）只做文件级读写；`api.ts` 路由与回环闸门；`core.test.ts` 用 node --test 覆盖解析、遮蔽、外科切换与合并写回。
- `web/src/`：React 19 + Vite + zustand。`api/client.ts` 薄封装；`store/app-store.ts` 管 home、预设登记与页脚消息；`components/` 下 HomeBar、Sidebar 与七个分区组件（表格列表 + 底部详情面板，已挂载分区保持状态）；`styles.css` 采用与 `apps/todo-web` 一致的黑白灰出版物式版面：mono 正文配 serif 小标题、直角按钮、方块开关、选中行内阴影与左侧竖线、底部 sheet 上滑动画。
