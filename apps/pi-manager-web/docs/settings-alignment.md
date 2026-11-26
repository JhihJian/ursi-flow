---
parent: ../SPEC.md
---

# Settings 能力对齐：pi-web 对话框 → pi-manager-web

## 结论

pi-web 的 Settings 对话框（`components/SettingsPanel.tsx`，根节点 `settings-dialog-surface`）是面向“当前会话 + 当前项目”的完整配置入口：它用 pi SDK 起运行时、加载扩展、安装插件、登录 OAuth、spawn MCP 测试，并把一部分偏好放在浏览器的 localStorage。

pi-manager-web 的职责不同：它只对任意 pi home 做**文件级**配置管理，不加载扩展、不安装、不 spawn、不驻留会话。因此“对齐”落在配置本身的能力：同一种配置项要能看见、能改、按 pi 的语义写回、按同一套遮蔽与并发保护处理。运行时行为（登录、安装、测试连接以外的探测）仍由 pi CLI / pi-web 负责。

本次按这个边界对齐了 general、models、skills、agents、mcp 五个分区的缺口，并补了对应的服务端校验与测试。

## 两边边界

| 维度 | pi-web Settings | pi-manager-web（本页） |
| --- | --- | --- |
| 作用对象 | 当前会话 + 当前 cwd 的全局与项目配置 | 任意 pi home 的全局配置文件 |
| 运行时 | 起 SDK runtime、加载扩展、注册 provider | 仅显式动作（目录采集、连接测试）起 SDK |
| 项目级配置 | `.pi/settings.json`、`.pi/mcp.json`、`.pi/agents/`、项目 skills | 不涉及，直接编辑项目文件 |
| 安装/登录 | 安装插件、npx 安装 skill、OAuth 登录 | 不做，交给 pi CLI / pi-web |
| 浏览器偏好 | 主题、字体、语言、发送键、侧栏布局 | 无 UI 宿主，不涉及 |

## 分区对齐矩阵

### 常规（General）

| pi-web 能力 | 对齐结果 |
| --- | --- |
| 内置工具开关（7 个） | 已对齐。服务端把 `defaultTools` 解析成实际工具集，开关写回最小 `+name` / `-name`；等于 pi 默认组合时删除 key。 |
| PowerShell 代替 bash（仅 Windows） | 已对齐。`PUT /api/general/shell` 只在 Windows 可用，写普通名字工具集。 |
| `showCacheMissNotices` | 已对齐。页面开关，关时删除 key。 |
| codemode `mode` / `inlineBudget` | 已有。 |
| 默认模型 / 思考级别 | 已有，且默认模型两个 key 一次写入。 |
| 浏览器偏好（主题、字体、语言、发送键、侧栏、通知、退出登录） | 不对齐：这些是 pi-web 页面自身偏好或 Web 认证能力，管理台没有会话界面。 |

### 模型（Models）

| pi-web 能力 | 对齐结果 |
| --- | --- |
| provider 条目编辑（baseUrl / api / headers / models / modelOverrides） | 已有（JSON 编辑，受管 key 合并写回）。 |
| models.json provider 校验（pi 会拒绝的条目） | 已对齐。写入前拒绝空条目，以及自带模型却写 `oauth` 不写 `baseUrl` 的自定义 provider；只写 `name` / `api` 的内置覆盖条目放行。非法条目 400 且不落盘。 |
| 不可解析的 models.json | 已对齐。读不出时 409 拒绝覆盖，不再静默清空。 |
| 测试连接 | 已对齐。用临时 models.json + 该 home 的 `auth.json` 起 `ModelRuntime`，发一次 16 token 请求，20s 超时。草稿的 `baseUrl` 与磁盘不同时不携带磁盘凭据；`!command` 凭据直接拒绝测试（管理台不执行命令）。 |
| 从上游发现模型 | 已对齐。请求 provider 的 `/models`，解析出 id/name/context/maxTokens/推理/图片，页面可“追加缺失的模型”（只改草稿，保存才落盘）。同样只在目标地址未变时使用磁盘凭据，掩码 header 不外发。 |
| 模型元数据列（Context / Max out / 能力） | 已对齐。provider 详情直接列出草稿里的模型与这三列。 |
| OAuth 登录 / API key 保存到 auth.json | 部分对齐：凭据条目本身可编辑（「凭据」分区）；登录流程不对齐，交给 pi CLI / pi-web。 |
| enabledModels 三态、provider 整组开关、modelOverrides 内联编辑 | 已有（`ScopedModelsPanel`），本次未改。 |
| models.dev 填充、模型高级字段（inputLimits / compat / thinkingLevelMap） | 不对齐。JSON 编辑已能表达全部字段；单独的引导式编辑器不增加配置能力。 |

### Skills

| pi-web 能力 | 对齐结果 |
| --- | --- |
| 列表 + 名称/描述过滤 | 已有。 |
| 详情：frontmatter + 正文 | 已对齐。新增 `GET /api/skills/content`，页面展示根级 frontmatter 原条目与正文，开关只改一行。 |
| 安装 / 更新 / 搜索（npx skills） | 不对齐：管理台不执行安装。 |
| 项目级 skills、信任门控 | 不对齐：本页只管 `<home>/skills`。 |

### Subagent（Agents）

| pi-web 能力 | 对齐结果 |
| --- | --- |
| 受管 frontmatter 的结构化编辑 | 已对齐。覆盖 `description`、`display_name`、`tools`、`load_skills`、`load_extensions`、`codemode`、`mcp`、`enabled`、`inherit_context`、`run_in_background`、`prompt_mode`、`model`、`thinking`、`max_turns`、`color`、`isolation`、`persist_session`。 |
| 未知 frontmatter key 原样保留 | 已对齐。按根级 key 分块保留（含缩进续行），保存时排在受管 key 之后；首个 key 前的注释也保留。受管 key 的值没改时重放原始块，注释与块标量不因无关保存丢失；表单里的“其它 key”拒绝受管 key 与非法行。 |
| `skills:` / `extensions:` 白名单 | 只读展示并原样保留。开关只写 `load_skills` / `load_extensions`，不重写白名单。 |
| 内置 agent 开关 / disabledBuiltIns / maxConcurrent | 已有。 |
| 内置 profile 的表单只读、来源遮蔽（global/workspace/project） | 不对齐：本页只有 global 一层，不读项目与 workspace。 |
| chat-only 约束、模型可用性提示 | 不对齐：需要 SDK 的模型与工具知识，管理台不做运行时校验。 |

### 插件

| pi-web 能力 | 对齐结果 |
| --- | --- |
| 条目列表、启用/禁用（四空数组编码）、带过滤器条目拒绝禁用 | 已有。 |
| 安装 / 更新 / 卸载、资源计数与诊断 | 不对齐：管理台不执行安装；条目与 `npm/` 目录核对已提供。 |

### MCP

| pi-web 能力 | 对齐结果 |
| --- | --- |
| 列表 + 详情（传输、cwd、env/header 名） | 已对齐。详情给出目标（command/url）、cwd、env 与 header 名。 |
| 字面量密钥遮蔽 | 已扩展到 `url`、`command`、`args` 与 `oauth.clientSecret`，并且局部遮蔽可逆：原样提交按「原文的遮蔽形式」还原，改成新值就写新值。 |
| `${VAR}` 引用与 `!command` 标注 | 已有，保持不展开、不执行。 |
| 隐藏字符警示 | 已对齐。含控制/零宽/双向字符的字段标出路径。 |
| `enabled` / `exposure` 开关 | 已对齐。只改这两个键；`enabled: true` 与 `exposure: codemode` 写回时删键（pi 的编辑器语义）。 |
| 测试连接、OAuth 登录、从其他客户端导入、删除撤销、项目覆盖 | 不对齐：都需要 spawn 或项目级写入，超出“文件级管理”的边界。JSON 编辑仍可完成新增与覆盖。 |

## 写入语义

与 pi-web 一致的几条：

- **乐观锁**：读到的 `revision = mtimeMs.size` 必须原样回传，文件被其他进程改过则 409，原文件保留。
- **备份与原子写**：写前复制 `<name>.bak-manager`，临时文件 + rename，模式 0600。
- **合并写回**：只改提交里出现的 key/条目，其余原样保留；`null` 表示删除。
- **遮蔽可逆**：凭据与 MCP 字面量密钥不回传明文；提交掩码视为“未改动”，提交新值写新值。
- **pi 的写回风格**：`settings.json` 2 空格缩进、不带结尾换行；MCP 的默认值（`enabled: true`、`exposure: "codemode"`）删键。

## 本次代码落点

服务端新增：

- `tool-settings.ts`：`defaultTools` 解析与最小写回、PowerShell 切换。
- `frontmatter.ts`：根级 key 的块级 YAML 解析与渲染，未知块原样保留。
- `models-check.ts`：pi 会拒绝的 provider 条目规则。
- `models-probe.ts`：连接测试与上游模型发现。
- `mcp-mask.ts`：URL / 命令 / 参数 / 字段值的可逆遮蔽。

服务端修改：`skills.ts`（内容读取）、`agents.ts`（结构化字段）、`mcp-file.ts`（遮蔽与 enabled/exposure）、`models-auth.ts`（校验、拒绝覆盖坏文件、草稿密钥还原）、`api.ts`（新路由）。

页面：`GeneralSection`（内置工具、缓存提示、PowerShell）、`ModelsSection`（模型列、连接测试、发现模型）、`SkillsSection`（内容预览）、`AgentsSection`（结构化表单）、`McpSection`（详情摘要、开关、隐藏字符）。
