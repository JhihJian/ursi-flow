# ursi-flow 架构与设计索引

Workbench 管理工作项和工作包，执行器平台（`executor-platform`）管理配置包、执行器修订和执行尝试。Flow Core 与 Flow Runtime 是只做推进的库，不带守护进程、Socket 或模型配置。MCP 服务管理模块（`mcp-web`）提供外部资源和工具，沙箱平台独立提供容器环境和服务端点。

## 模块职责

| 模块 | 职责与数据归属 |
| --- | --- |
| [工作区外壳](packages/workspace-shell/SPEC.md) | 固定骨架与全局选中：标题栏、可堆叠的侧边栏、工作区、右侧控制面板、状态栏。模块只声明侧边栏、工作区与上下文，外壳负责布局、折叠、选中分派与操作渲染，不含领域逻辑。独立入口在 `shell-web`，todo、fs、ssh、沙箱与 pi-web 以 npm workspace 包或源码模块接入，组合关系见 `shell-web/src/registry.tsx`。新模块按 [接入规范](packages/workspace-shell/MODULE-CONTRACT.md) 实现。 |
| [SUMM-Todo 看板](apps/todo-web/SPEC.md) | 独立的待办 Web 看板，读写 SUMM-Todo 本机 SQLite 库，展示项目、任务和周期统计。 |
| [SSH 终端](apps/ssh-web/SPEC.md) | 独立的浏览器 SSH 终端，服务端启动系统 OpenSSH 子进程（`ssh -tt`）建立会话，WebSocket 桥接 xterm.js 与远端 PTY。连接配置存本机 SQLite，可按 [工作区接入设计](docs/design/ssh-web/WORKSPACE-INTEGRATION.md) 作为一栏接入 shell-web。 |
| [dae 路由观察台](apps/dae-web/SPEC.md) | 本机 dae 的观察与配置界面。零依赖 Node 服务托管 React 页面，把 `/api` 转发到 dae native API 并注入 Bearer token（dae 只监听 loopback、拒绝外部 Origin、启用 api.secret），展示运行态、连接、流历史、规则、DNS 与日志，回放连接的路由判决，并按配置源编排校验与写入。 |
| [Workbench](workbench/SPEC.md) | Web 通过同源 API 访问 Server。Server 保存工作清单、工作包和工作包生成器。 |
| [执行器管理平台](executor-platform/server/SPEC.md) | `ursi-executor-platform` 保存冻结配置、执行尝试和只读制品。独立管理页维护配置包、资源、后端和执行器修订，Agent 工作区显示 ACP 执行过程。 |
| [Pi Web](docs/design/pi-web/INTEGRATION.md) | 上游 pi coding agent 的完整 Web UI，以 git subtree 从 fork `JhihJian/pi-web` 接入 `apps/pi-web`，内容不改造。进程内驱动 AgentSession，与 CLI 共享 `~/.pi/agent`，浏览器里完整使用 Pi agent。 |
| [Pi 管理台](apps/pi-manager-web/SPEC.md) | 对任意给定的 pi home（默认 `~/.pi/agent`）做文件级配置管理：settings 受管项、skills 开关、subagent profile 与内置开关、MCP 与自定义模型条目、凭据。Node 服务托管 React 页面，以读写配置文件为主；另提供执行一次性会话任务的接口（agent = pi home 名，可选按 agents/ 里的 subagent 定义启动，pi SDK 按需加载）。凭据遮蔽、写操作限回环、乐观锁加原子写。 |
| [Flow Core](flow-core/SPEC.md) | 独立 SDK，从 `FLOW.md` 或当前 JSON 快照和回执生成待办。解析、变量和路由规则供引擎复用。 |
| [Flow Runtime](flow-runtime/SPEC.md) | 只有三部分的库：引擎把 FLOW.md 推到最终结果，过程日志实体定义观测记录，文件存储保存这些记录。执行 Agent 的唯一依赖是 `prompt(agentName, instruct)`。不持有进程、Socket 与模型配置。 |
| [执行器 MCP SDK](executor-sdk/SPEC.md) | Node.js MCP 服务端库，供独立的整条 Flow MCP 适配器等服务使用。SDK 负责协议发现和校验，运行状态由使用它的服务持有。 |
| [MCP 服务管理](apps/mcp-web/SPEC.md) | 管理已登记的 Streamable HTTP MCP 服务，提供资源浏览和授权工具调用。后端库与 Web 页面可嵌入 Workbench，也可由独立管理台托管。 |
| [沙箱平台](apps/ursi-sandbox/SPEC.md) | Builder 构建镜像和服务包，注册表校验组合，容器内 Runtime 装配服务。Gateway 管理实例、工作卷和端点，Observer 可选配。 |

## 模块关系

- **查看待办。** SUMM-Todo 看板由自己的 Rust 服务托管 React 页面并提供同源 API，读写 `~/.ursi/todo/todo.db`；它不依赖 ursi-flow 的 Workbench 或 Flow。
- **连上主机。** SSH 终端由自己的 Rust 服务托管页面并提供同源 API 与 WS 桥，读写 `~/.ursi/ssh/ssh.db`，同样不依赖 ursi-flow 的其他模块。它也以 `@ursi/ssh-web/module` 接入 [工作区外壳](packages/workspace-shell/SPEC.md) 成为独立一栏，服务与数据归属不变。
- **看清出站路由。** dae 路由观察台由零依赖 Node 服务托管页面，按 dae native API 读取本机代理状态，不持有自己的数据；连接与流记录留在 dae 进程内存，重启即丢。配置采用 dae 的 managed layout，写入由 dae 自己完成，本服务只注入 token、编排校验与等待热加载。
- **推进一次 Flow。** [Flow Runtime](flow-runtime/SPEC.md) 的引擎读 FLOW.md，把每一步渲染好的提示词交给执行器，校验回执后交给 Flow Core 选边，并把过程写成日志实体与可恢复快照。
- **执行一次工作。** Workbench 用服务令牌通过 HTTP 调用固定的执行器修订。执行器平台通过本机 ACP v2 stdio 驱动受管 Agent 并收集制品。
- **浏览器使用 Pi agent。** `apps/pi-web` 是完整的 Pi Web UI，进程内启动 AgentSession，与 CLI 共享 `~/.pi/agent` 的模型、会话、技能和 MCP 配置，浏览器里完整使用 Pi agent 能力。该入口独立于执行器平台和 Flow 的 ACP 链路。
- **管理 Pi 配置文件。** Pi 管理台与 Pi Web、CLI 读同一份 pi home：三者并发修改靠文件级乐观锁与备份互不覆盖；管理台只做配置编辑，会话运行交给 Pi Web 与 CLI。
- **生成工作包。** Workbench 通过内嵌的 `mcp-web` 读取授权的 HTTP MCP 资源，再交给 Python 配方或版本化生成器。文件与生成来源归 Workbench，发布工作包独立于启动 Flow 或 Agent。
- **使用沙箱。** 外部调用方通过 Gateway 打开已登记的 SSH、浏览器或 ACP 等端点，业务会话由对应服务持有。现行 Flow 的命令和 Pi 节点直接在本机工作目录运行，无需 Gateway。

## 设计索引

设计统一放在 [`docs/design/`](docs/design/)，按所属模块分组。新增设计在本页登记。模块功能与验收见各 `SPEC.md`，协议和部署说明随所属模块维护。

| 主题 | 设计文档 |
| --- | --- |
| Workbench Server | [工作清单、目录与定义](docs/design/workbench/SERVER-WORK-MANAGEMENT.md) |
| Workbench Web | [工作管理界面](docs/design/workbench/WEB-WORK-MANAGEMENT.md) |
| SUMM-Todo 看板 | [布局、拖拽与数据流](docs/design/todo-web/DASHBOARD.md) · [执行集成与嵌入形态](docs/design/todo-web/EXECUTION-AND-EMBEDDING.md) · [工作区外壳与模块组合](docs/design/todo-web/WORKSPACE-SHELL.md) |
| 会话查看工作台 | [模块结构、解析与嵌入](docs/design/session-viewer/SESSION-VIEWER.md) |
| SSH 终端 | [接入工作区外壳](docs/design/ssh-web/WORKSPACE-INTEGRATION.md) |
| dae 路由观察台 | [同源代理、页面结构与刷新策略](docs/design/dae-web/OVERVIEW.md) |
| 工作项与文件包 | [工作清单与包来源](docs/design/workbench/WORK-LIST-DESIGN.md) · [版本化工作包生成器](docs/design/workbench/WORK-PATCH-GENERATOR-DESIGN.md) · [工作包和配置包编辑台](docs/design/workbench/PATCH-STUDIO.md) |
| 执行器 | [平台拆分与调用边界](docs/design/executor-platform/OVERVIEW.md) · [执行器协议统一为 ACP 的提案](docs/design/executor-platform/ACP-BACKEND.md) · [ACP 执行契约](docs/design/executor-platform/ACP-PROFILE.md) · [ACP 基线与首版范围](docs/design/executor-platform/ACP-SCOPE.md) · [平台部署](executor-platform/server/README.md) · [定义与尝试](docs/design/workbench/EXECUTOR-DESIGN.md) · [Agent 执行器](docs/design/workbench/PI-AGENT-EXECUTOR-DESIGN.md) |
| Pi Web | [迁移与集成](docs/design/pi-web/INTEGRATION.md) |
| Flow Core | [Flow Core SDK 设计](docs/design/flow-runtime/FLOW-CORE.md) |
| Flow 能力 | [Agent 会话](docs/design/flow-runtime/ability/agent-harness.md) · [运行时工具](docs/design/flow-runtime/ability/runtime-tools.md) · [命令执行](docs/design/flow-runtime/ability/command-execution.md) · [并行执行](docs/design/flow-runtime/ability/parallel-execution.md) · [用户确认门禁](docs/design/flow-runtime/ability/user-confirmation.md)（[实现改动](docs/design/flow-runtime/ability/user-confirmation-impl.md)） |
| MCP 服务管理 | [独立模块与宿主边界](docs/design/mcp-web/MCP-MODULE-DESIGN.md) · [执行器协议发现与标签](docs/design/mcp-web/EXECUTOR-DISCOVERY-DESIGN.md) |
| 沙箱平台 | [构建、实例与端点](docs/design/ursi-sandbox/SANDBOX-PLATFORM.md) · [网络观测页面](docs/design/ursi-sandbox/NETWORK-OBSERVATION.md) · [控制台接入工作区](docs/design/ursi-sandbox/WORKSPACE-INTEGRATION.md) |

相关入口：[根规格](SPEC.md) · [Flow 导读](flow-core/docs/flow-overview.md) · [Flow 文件规范](flow-core/docs/flow-spec.md) · [执行器 MCP 协议](docs/EXECUTOR-MCP.md) · [Workbench 执行器接入](workbench/EXECUTOR-INTEGRATION.md)。
