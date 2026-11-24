# ursi-flow 架构与设计索引

项目门户提供独立首页和可选应用入口。Workbench 管理工作项和工作包，执行器平台（`executor-platform`）管理配置包、执行器修订和执行尝试，Flow Runtime 负责流程编排和运行历史。MCP 服务管理模块（`ursi-mcp`）提供外部资源和工具，沙箱平台独立提供容器环境和服务端点。

## 模块职责

| 模块 | 职责与数据归属 |
| --- | --- |
| [项目门户](apps/web/SPEC.md) | `/` 展示已发布的项目资料和应用入口。`/manage/` 编辑并导出草稿，部署流程发布共享配置。 |
| [工作区外壳](packages/workspace-shell/SPEC.md) | 多栏骨架与全局选中：模块声明栏与操作，外壳负责布局、折叠、选中分派，不含领域逻辑。独立入口在 `shell-web`，已完成 todo 与 fs-web 模块接入。新模块按 [接入规范](packages/workspace-shell/MODULE-CONTRACT.md) 实现。 |
| [SUMM-Todo 看板](todo-web/SPEC.md) | 独立的待办 Web 看板，读写 SUMM-Todo 本机 SQLite 库，展示项目、任务和周期统计。 |
| [页面布局](packages/ui-layout/SPEC.md) · [UI 插槽](packages/ui-slots/SPEC.md) | 布局包负责响应式排列，插槽包负责注册与渲染贡献。两者可由其他 React 页面单独使用。 |
| [Workbench](workbench/SPEC.md) | Web 通过同源 API 访问 Server。Server 保存工作清单、工作包和工作包生成器。 |
| [执行器管理平台](executor-platform/server/SPEC.md) | `ursi-executor-platform` 保存冻结配置、执行尝试和只读制品。独立管理页维护配置包、资源、后端和执行器修订，Agent 工作区显示 ACP 执行过程。 |
| [Pi Web 前端](pi-executor/SPEC.md) | 独立静态前端。首页连接会话服务，按权限观察或继续 Pi 会话。 |
| [Pi SDK 会话服务](pi-executor/session-service/SPEC.md) | 独立 HTTP 服务，持有 Pi 会话运行实例与 JSONL 历史，提供提交、停止和只读订阅。 |
| [Flow Core](flow-core/SPEC.md) | 独立 SDK，从 `FLOW.md` 或当前 JSON 快照和回执生成待办。解析、变量和路由规则供 Runtime 复用。 |
| [Flow Runtime](flow-runtime/SPEC.md) | 校验并执行 `FLOW.md` 包，以节点结果决定下一步。`ursi-flowd` 持有流程修订、运行配置、Run 和节点历史，可由独立控制台或 CLI 操作。 |
| [执行器 MCP SDK](executor-sdk/SPEC.md) | Node.js MCP 服务端库，供独立的整条 Flow MCP 适配器等服务使用。SDK 负责协议发现和校验，运行状态由使用它的服务持有。 |
| [MCP 服务管理](ursi-mcp/SPEC.md) | 管理已登记的 Streamable HTTP MCP 服务，提供资源浏览和授权工具调用。后端库与 Web 页面可嵌入 Workbench，也可由独立管理台托管。 |
| [沙箱平台](ursi-sandbox/SPEC.md) | Builder 构建镜像和服务包，注册表校验组合，容器内 Runtime 装配服务。Gateway 管理实例、工作卷和端点，Observer 可选配。 |

## 模块关系

- **从门户进入应用。** 门户声明插槽及位置，构建时登记的源码插件提供内容。Workbench 插件通过发布配置中的 `workbenchUrl` 链接到独立部署，其 `/` 仍是 Workbench 内部路由，认证与 API 由 Workbench 处理。
- **查看待办。** SUMM-Todo 看板由自己的 Rust 服务托管 React 页面并提供同源 API，读写 `~/.ursi/todo/todo.db`；它不依赖 ursi-flow 的门户、Workbench 或 Flow。
- **管理 Flow。** Workbench 的可选 `/api/v1` 通过 Rust `FlowClient` 连接 daemon 的 Unix socket。[CLI](flow-runtime/client/SPEC.md) 直连 daemon，[独立控制台](flow-runtime/web/SPEC.md) 通过自己的同源桥接入。连接同一 daemon 的三个入口共享运行历史。
- **执行一次工作。** Workbench 和 Flow Runtime 各自用服务令牌通过 HTTP 调用固定的执行器修订。执行器平台通过本机 ACP v2 stdio 驱动受管 Agent 并收集制品。Flow Runtime 校验节点提交的结果后选择后续路径。
- **共享 Pi 会话。** 外部调用方和 Pi Web 实时页以同一 `sessionId` 访问会话服务。只读接口提供历史和实时快照，只有显式提交才会打开 Agent。该入口独立于执行器平台和 Flow 的 ACP 链路。
- **生成工作包。** Workbench 通过内嵌的 `ursi-mcp` 读取授权的 HTTP MCP 资源，再交给 Python 配方或版本化生成器。文件与生成来源归 Workbench，发布工作包独立于启动 Flow 或 Agent。
- **使用沙箱。** 外部调用方通过 Gateway 打开已登记的 SSH、浏览器或 ACP 等端点，业务会话由对应服务持有。现行 Flow 的命令和 Pi 节点直接在本机工作目录运行，无需 Gateway。

## 设计索引

设计统一放在 [`docs/design/`](docs/design/)，按所属模块分组。新增设计在本页登记。模块功能与验收见各 `SPEC.md`，协议和部署说明随所属模块维护。

| 主题 | 设计文档 |
| --- | --- |
| Workbench Server | [Flow 管理与进程边界](docs/design/workbench/SERVER-FLOW.md) · [工作清单、目录与定义](docs/design/workbench/SERVER-WORK-MANAGEMENT.md) |
| Workbench Web | [应用壳、认证与 Flow 工具](docs/design/workbench/WEB-SHELL-AND-FLOW.md) · [工作管理界面](docs/design/workbench/WEB-WORK-MANAGEMENT.md) |
| SUMM-Todo 看板 | [布局、拖拽与数据流](docs/design/todo-web/DASHBOARD.md) · [执行集成与嵌入形态](docs/design/todo-web/EXECUTION-AND-EMBEDDING.md) · [工作区外壳与模块组合](docs/design/todo-web/WORKSPACE-SHELL.md) |
| 会话查看工作台 | [模块结构、解析与嵌入](docs/design/session-viewer/SESSION-VIEWER.md) |
| 工作项与文件包 | [工作清单与包来源](docs/design/workbench/WORK-LIST-DESIGN.md) · [版本化工作包生成器](docs/design/workbench/WORK-PATCH-GENERATOR-DESIGN.md) · [工作包和配置包编辑台](docs/design/workbench/PATCH-STUDIO.md) |
| 执行器 | [平台拆分与调用边界](docs/design/executor-platform/OVERVIEW.md) · [执行器协议统一为 ACP 的提案](docs/design/executor-platform/ACP-BACKEND.md) · [ACP 执行契约](docs/design/executor-platform/ACP-PROFILE.md) · [ACP 基线与首版范围](docs/design/executor-platform/ACP-SCOPE.md) · [平台部署](executor-platform/server/README.md) · [定义与尝试](docs/design/workbench/EXECUTOR-DESIGN.md) · [Flow 执行器](docs/design/workbench/FLOW-EXECUTOR-DESIGN.md) · [Agent 执行器](docs/design/workbench/PI-AGENT-EXECUTOR-DESIGN.md) · [Runtime MCP 适配器](docs/design/flow-runtime/MCP-ADAPTER.md) |
| Pi 会话 | [前端部署](pi-executor/README.md) · [会话 API 与服务部署](pi-executor/session-service/README.md) |
| Flow Core | [Flow Core SDK 设计](docs/design/flow-runtime/FLOW-CORE.md) |
| Flow 能力 | [Agent 装配](docs/design/flow-runtime/ability/agent-assembly.md) · [Agent 生命周期](docs/design/flow-runtime/ability/agent-harness.md) · [Agent 会话复用](docs/design/flow-runtime/ability/agent-continuity.md) · [运行时工具](docs/design/flow-runtime/ability/runtime-tools.md) · [命令执行](docs/design/flow-runtime/ability/command-execution.md) · [子 Flow](docs/design/flow-runtime/ability/child-flow.md) · [并行执行](docs/design/flow-runtime/ability/parallel-execution.md) · [用户确认门禁](docs/design/flow-runtime/ability/user-confirmation.md)（[实现改动](docs/design/flow-runtime/ability/user-confirmation-impl.md)）· [节点级执行器选择](docs/design/flow-runtime/NODE-EXECUTORS.md) |
| MCP 服务管理 | [独立模块与宿主边界](docs/design/ursi-mcp/MCP-MODULE-DESIGN.md) · [执行器协议发现与标签](docs/design/ursi-mcp/EXECUTOR-DISCOVERY-DESIGN.md) |
| 沙箱平台 | [构建、实例与端点](docs/design/ursi-sandbox/SANDBOX-PLATFORM.md) · [网络观测页面](docs/design/ursi-sandbox/NETWORK-OBSERVATION.md) · [控制台接入工作区](docs/design/ursi-sandbox/WORKSPACE-INTEGRATION.md) |

相关入口：[根规格](SPEC.md) · [Flow 导读](flow-core/docs/flow-overview.md) · [Flow 文件规范](flow-core/docs/flow-spec.md) · [执行器 MCP 协议](docs/EXECUTOR-MCP.md) · [Workbench 执行器接入](workbench/EXECUTOR-INTEGRATION.md)。
