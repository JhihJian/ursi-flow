# ursi-flow 架构与设计索引

Flow Core 与 Flow Runtime 是只做推进的库，不带守护进程、Socket 或模型配置。MCP 服务管理模块（`mcp-web`）提供外部资源和工具，沙箱平台独立提供容器环境和服务端点。

## 模块职责

| 模块 | 职责与数据归属 |
| --- | --- |
| [工作区外壳](packages/workspace-shell/SPEC.md) | 固定骨架与全局选中：标题栏、可堆叠的侧边栏、工作区、右侧控制面板、状态栏。模块只声明侧边栏、工作区与上下文，外壳负责布局、折叠、选中分派与操作渲染，不含领域逻辑。独立入口在 `shell-web`，todo、fs、ssh、沙箱与 pi-web 以 npm workspace 包或源码模块接入，组合关系见 `shell-web/src/registry.tsx`。新模块按 [接入规范](packages/workspace-shell/MODULE-CONTRACT.md) 实现。 |
| [SUMM-Todo 看板](apps/todo-web/SPEC.md) | 独立的待办 Web 看板，读写 SUMM-Todo 本机 SQLite 库，展示项目、任务和周期统计。 |
| [SSH 终端](apps/ssh-web/SPEC.md) | 独立的浏览器 SSH 终端，服务端启动系统 OpenSSH 子进程（`ssh -tt`）建立会话，WebSocket 桥接 xterm.js 与远端 PTY。连接配置存本机 SQLite，可按 [工作区接入设计](docs/design/ssh-web/WORKSPACE-INTEGRATION.md) 作为一栏接入 shell-web。 |
| [dae 路由观察台](apps/dae-web/SPEC.md) | 本机 dae 的观察与配置界面。零依赖 Node 服务托管 React 页面，把 `/api` 转发到 dae native API 并注入 Bearer token（dae 只监听 loopback、拒绝外部 Origin、启用 api.secret），展示运行态、连接、流历史、规则、DNS 与日志，回放连接的路由判决，并按配置源编排校验与写入。 |
| [Flow 工作台](apps/flow-web/SPEC.md) | 浏览器里的 Flow 工作台。Node 服务用 `apps/ursi-flow` 推进流程、把运行写入自己的状态目录，并托管 React 页面；页面可独立打开，也作为 `flow` 模块接入工作区外壳。 |
| [Pi Web](docs/design/pi-web/INTEGRATION.md) | 上游 pi coding agent 的完整 Web UI，以 git subtree 从 fork `JhihJian/pi-web` 接入 `apps/pi-web`，内容不改造。进程内驱动 AgentSession，与 CLI 共享 `~/.pi/agent`，浏览器里完整使用 Pi agent。 |
| [Pi 管理台](apps/pi-manager-web/SPEC.md) | 对任意给定的 pi home（默认 `~/.pi/agent`）做文件级配置管理：settings 受管项、skills 开关、subagent profile 与内置开关、MCP 与自定义模型条目、凭据。Node 服务托管 React 页面，以读写配置文件为主；另提供一次性会话任务的接口与交互对话的运行时（`session-runtime` 装配与释放、`chat` 的 SSE 与扩展 UI 桥接，pi SDK 按需加载），并汇总会话心跳运行态供会话模块展示。凭据遮蔽、写操作按可信局域网边界开放、乐观锁加原子写。同时以 `pi-config` 模块接入工作区外壳。 |
| [Pi 会话浏览](apps/pi-sessions-web/SPEC.md) | 浏览磁盘上的 pi 会话：在浏览器里指定任意 sessions 根目录，按项目分组列出会话并用轨迹组件库渲染正文，可把项目设为特别关注、删除单个会话。零依赖 Node 服务负责扫描、按 id 定位与格式兼容，不启动 pi，删除的作用范围限定在当前根目录内，与 `pi-web` 不共享代码。宿主可注入会话运行态与「在对话里继续」能力，模块本身不采集心跳、不依赖其他模块。 |
| [Pi 交互对话](apps/pi-chat-web/SPEC.md) | 浏览器里的多轮对话：选一份 pi home 即选整套配置（模型、凭据、skills、agents、MCP），流式输出、工具调用可见、可打断、可续聊。运行时全部在 Pi 管理台，本模块只做界面并复用会话模块同一份轨迹组件库；会话文件写回该 home 的 `sessions/`，因此 CLI、Pi Web 与会话浏览都能接着读。 |
| [ursi-flow](apps/ursi-flow/SPEC.md) | 交付包：装配一次运行并提供 `ursi-flow` 命令行，把 `FLOW.md` 推到最终结果。包内含 `core`、`executor`、`runtime` 三个模块。 |
| [Flow Core](apps/ursi-flow/core/SPEC.md) | 无状态推进 SDK，从 `FLOW.md` 或当前 JSON 快照和回执生成待办。解析、变量和路由规则供引擎复用。 |
| [Flow Executor](apps/ursi-flow/executor/SPEC.md) | 引擎与外部世界之间唯一的契约：`prompt(agentName, instruct)` 与 `command(invocation)`。适配层按契约接入具体执行方式，首个适配器是 `FakeExecutor`。 |
| [Flow Runtime](apps/ursi-flow/runtime/SPEC.md) | 只有三部分的库：引擎把 FLOW.md 推到最终结果，过程日志实体定义观测记录，文件存储保存这些记录。只依赖 Core 与执行器契约，不持有进程、Socket 与模型配置。 |
| [MCP 服务管理](apps/mcp-web/SPEC.md) | 管理已登记的 Streamable HTTP MCP 服务，提供资源浏览和授权工具调用。独立管理台托管后端库与 Web 页面，两者也可嵌入其他宿主。 |
| [沙箱平台](apps/ursi-sandbox/SPEC.md) | Builder 构建镜像和服务包，注册表校验组合，容器内 Runtime 装配服务。Gateway 管理实例、工作卷和端点，Observer 可选配。 |

## 模块关系

- **查看待办。** SUMM-Todo 看板由自己的 Rust 服务托管 React 页面并提供同源 API，读写 `~/.ursi/todo/todo.db`；它不依赖 ursi-flow 的其他模块。
- **连上主机。** SSH 终端由自己的 Rust 服务托管页面并提供同源 API 与 WS 桥，读写 `~/.ursi/ssh/ssh.db`，同样不依赖 ursi-flow 的其他模块。它也以 `@ursi/ssh-web/module` 接入 [工作区外壳](packages/workspace-shell/SPEC.md) 成为独立一栏，服务与数据归属不变。
- **看清出站路由。** dae 路由观察台由零依赖 Node 服务托管页面，按 dae native API 读取本机代理状态，不持有自己的数据；连接与流记录留在 dae 进程内存，重启即丢。配置采用 dae 的 managed layout，写入由 dae 自己完成，本服务只注入 token、编排校验与等待热加载。
- **推进一次 Flow。** [Flow Runtime](apps/ursi-flow/runtime/SPEC.md) 的引擎读 FLOW.md，把每一步渲染好的提示词交给执行器，校验回执后交给 Flow Core 选边，并把过程写成日志实体与可恢复快照。
- **在浏览器里跑 Flow。** [Flow 工作台](apps/flow-web/SPEC.md) 的服务端读用户 flow home 里的 `FLOW.md`，用 `apps/ursi-flow` 的引擎开跑并保存运行；页面负责选包、填变量、回答人工确认与看过程日志。运行事实归工作台状态目录，Flow 包本身只读。它同时是工作区外壳里的 `flow` 模块，通过组合根注入的文件模块命令打开 Flow 目录。
- **执行一个 Flow 包。** [ursi-flow](apps/ursi-flow/SPEC.md) 把 Core、执行器与 Runtime 装配成一次运行：`runFlow` 负责装配与确认问答，命令行负责加载包、传变量与打印结果。执行器只实现 `prompt` 与 `command` 两个方法，换成真实 Agent 时其他模块不动。
- **回看历史会话。** Pi 会话浏览读磁盘上的 `.jsonl`，根目录当场指定，因此本机会话、备份和别人的导出都能看；它不启动 agent，登录、配置与会话写入都不在它的职责内，写操作只有用户主动删除会话文件与记录特别关注的项目，服务假定运行在可信局域网。
- **浏览器使用 Pi agent。** `apps/pi-web` 是完整的 Pi Web UI，进程内启动 AgentSession，与 CLI 共享 `~/.pi/agent` 的模型、会话、技能和 MCP 配置，浏览器里完整使用 Pi agent 能力。该入口与 Flow 运行链路相互独立。
- **管理 Pi 配置文件。** Pi 管理台与 Pi Web、CLI 读同一份 pi home：三者并发修改靠文件级乐观锁与备份互不覆盖。管理台以配置编辑为主，另可按 pi home 名（即 agent 名）执行一次性会话任务，并提供交互对话的运行时与会话运行态数据。
- **在浏览器里对话。** Pi 交互对话消费管理台的对话接口，选 home 即选模型、凭据与 skills；会话文件写在同一个 `sessions/`，聊完能在 Pi 会话浏览里看完整轨迹，历史会话也能反向「在对话里继续」。三者通过工作台组合根用命令与普通值接线（`openSession`、`resumeSession`、运行态来源），各自仍可独立部署。
- **使用沙箱。** 外部调用方通过 Gateway 打开已登记的 SSH、浏览器或 ACP 等端点，业务会话由对应服务持有。现行 Flow 的命令和 Pi 节点直接在本机工作目录运行，无需 Gateway。

## 设计索引

设计统一放在 [`docs/design/`](docs/design/)，按所属模块分组。新增设计在本页登记。模块功能与验收见各 `SPEC.md`，协议和部署说明随所属模块维护。

| 主题 | 设计文档 |
| --- | --- |
| SUMM-Todo 看板 | [布局、拖拽与数据流](docs/design/todo-web/DASHBOARD.md) · [工作区外壳与模块组合](docs/design/todo-web/WORKSPACE-SHELL.md) |
| Pi 会话浏览 | 接口与扫描规则见 [服务端契约](apps/pi-sessions-web/server/HTTP.md) |
| SSH 终端 | [接入工作区外壳](docs/design/ssh-web/WORKSPACE-INTEGRATION.md) |
| dae 路由观察台 | [同源代理、页面结构与刷新策略](docs/design/dae-web/OVERVIEW.md) |
| Pi Web | [迁移与集成](docs/design/pi-web/INTEGRATION.md) · [职责拆分与再聚合](docs/design/pi-web/SPLIT-AND-AGGREGATION.md) |
| Pi 交互对话 | [对话运行时、界面与依赖关系](docs/design/pi-chat-web/CHAT.md) |
| Flow Core | [Flow Core SDK 设计](docs/design/flow-runtime/FLOW-CORE.md) |
| ursi-flow 交付包 | [引擎、日志实体与日志存储](docs/design/flow-runtime/RUNTIME.md) |
| Flow 工作台 | [接口、页面与数据归属](apps/flow-web/README.md) |
| Flow 能力 | [Agent 会话](docs/design/flow-runtime/ability/agent-harness.md) · [运行时工具](docs/design/flow-runtime/ability/runtime-tools.md) · [命令执行](docs/design/flow-runtime/ability/command-execution.md) · [并行执行](docs/design/flow-runtime/ability/parallel-execution.md) · [用户确认门禁](docs/design/flow-runtime/ability/user-confirmation.md)（[实现改动](docs/design/flow-runtime/ability/user-confirmation-impl.md)） |
| MCP 服务管理 | [识别规则与标签](docs/design/mcp-web/RECOGNITION-RULES.md) |
| 沙箱平台 | [构建、实例与端点](docs/design/ursi-sandbox/SANDBOX-PLATFORM.md) · [网络观测页面](docs/design/ursi-sandbox/NETWORK-OBSERVATION.md) · [控制台接入工作区](docs/design/ursi-sandbox/WORKSPACE-INTEGRATION.md) |
| 单机部署 | [入口、路由与发布流程](docs/design/deployment/DEPLOYMENT.md) |

相关入口：[根规格](SPEC.md) · [Flow 导读](apps/ursi-flow/docs/flow-overview.md) · [Flow 文件规范](apps/ursi-flow/docs/flow-spec.md)。
