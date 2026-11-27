# ursi-flow 架构与设计索引

Flow Core 与 Flow Runtime 是只做推进的库，不带守护进程、Socket 或模型配置。MCP 服务管理模块（`mcp-web`）提供外部资源和工具，沙箱平台独立提供容器环境和服务端点。

## 模块职责

| 模块 | 职责与数据归属 |
| --- | --- |
| [工作区外壳](packages/workspace-shell/SPEC.md) | 固定骨架与全局选中：标题栏、可堆叠的侧边栏、工作区、右侧控制面板、状态栏。模块只声明侧边栏、工作区与上下文，外壳负责布局、折叠、选中分派与操作渲染，不含领域逻辑。独立入口在 `shell-web`，todo、fs、ssh、沙箱与 pi 系列模块以 npm workspace 包或仓库内源码接入，组合关系见 `shell-web/src/registry.tsx`。新模块按 [接入规范](packages/workspace-shell/MODULE-CONTRACT.md) 实现。 |
| [位置契约](packages/location/SPEC.md) | 纯函数包 `@ursi/location`，定义工作目录的身份：`file:///abs/path` 与 `ssh://<设备>/abs/path`。解析、构造、派生相邻位置、求持久化键，前后端共用。它是约定不是服务：没有进程与数据库，设备清单归 ssh-web。设计见 [URI 契约](docs/design/location/URI-CONTRACT.md)。 |
| [目录选择组件](packages/directory-picker/SPEC.md) | 共享 UI 包：给各应用的「输入服务器目录」场景提供统一的目录浏览组件（设备下拉 + 面包屑 + 路径/过滤二合一 + 子目录列表）。目标与结果都是位置 URI，数据由调用方注入 `listDir`，设备清单由调用方注入 `devices`，浏览路由归各应用服务端；fs-web 添加目录与 pi-web 选根 / 新增 pi home 已接入。 |
| [侧栏共用组件](packages/sidebar/SPEC.md) | 共享 UI 包：收编各应用侧边栏重复的右键菜单 `ContextMenu`（五份拷贝，四份违反样式契约的 `position: fixed`）与列表行的「左侧 2px 竖线 + hover 灰底」样式。菜单 portal 进调用方指定的不滚动容器，坐标相对容器；不做树组件，也不做带 slots 的行组件，行的结构留给各应用。todo、ssh、fs、pi、flow 的侧边栏已接入。 |
| [fs-web 文件管理器](apps/fs-web/SPEC.md) | 工作区的文件资源管理器：目录树、文件编辑、目录操作与 git 状态视图。每个 workspace 是一个位置 URI，本机目录与 SSH 远程目录共用同一套界面与操作，远程目录经 ssh-web 取连接参数、一次操作一次 ssh 调用，没有 git 视图。 |
| [SUMM-Todo 看板](apps/todo-web/SPEC.md) | 独立的待办 Web 看板，读写 SUMM-Todo 本机 SQLite 库，展示项目、任务和周期统计。 |
| [SSH 终端](apps/ssh-web/SPEC.md) | 独立的浏览器 SSH 终端，服务端启动系统 OpenSSH 子进程（`ssh -tt`）建立会话，WebSocket 桥接 xterm.js 与远端 PTY。连接配置存本机 SQLite，可按 [工作区接入设计](docs/design/ssh-web/WORKSPACE-INTEGRATION.md) 作为一栏接入 shell-web。 |
| [dae 路由观察台](apps/dae-web/SPEC.md) | 本机 dae 的观察与配置界面。零依赖 Node 服务托管 React 页面，把 `/api` 转发到 dae native API 并注入 Bearer token（dae 只监听 loopback、拒绝外部 Origin、启用 api.secret），展示运行态、连接、流历史、规则、DNS 与日志，回放连接的路由判决，并按配置源编排校验与写入。 |
| [Flow 工作台](apps/flow-web/SPEC.md) | 浏览器里的 Flow 工作台。Node 服务用 `apps/ursi-flow` 推进流程、把运行写入自己的状态目录，并托管 React 页面；页面可独立打开，也作为 `flow` 模块接入工作区外壳。 |
| [Pi Web](apps/pi-web/SPEC.md) | 浏览器里的 pi 工作台：配置、对话、会话浏览共用一个进程与一套领域模型。一份 pi home 决定整套能力（模型、凭据、skills、agents、MCP、工具策略），会话只有一个身份 `sessionId`，磁盘历史、内存加载、流式对话、一次性任务与子进程心跳都是同一个实体会话的不同投影。零依赖 Node 服务同时提供文件级配置读写、常驻对话运行时（SSE 与扩展 UI 桥接）、任意根目录的会话扫描与轨迹，并以 `pi` 模块接入工作区外壳，一个侧栏（home、会话列表）配两种页面（会话、配置），建立、发起、继续会话只有会话页一个入口，路由键只用 sessionId。 |
| [ursi-flow](apps/ursi-flow/SPEC.md) | 交付包：装配一次运行并提供 `ursi-flow` 命令行，把 `FLOW.md` 推到最终结果。包内含 `core`、`executor`、`runtime` 三个模块。 |
| [Flow Core](apps/ursi-flow/core/SPEC.md) | 无状态推进 SDK，从 `FLOW.md` 或当前 JSON 快照和回执生成待办。解析、变量和路由规则供引擎复用。 |
| [Flow Executor](apps/ursi-flow/executor/SPEC.md) | 引擎与外部世界之间唯一的契约：`prompt(agentName, instruct)` 与 `command(invocation)`。适配层按契约接入具体执行方式，首个适配器是 `FakeExecutor`。 |
| [Flow Runtime](apps/ursi-flow/runtime/SPEC.md) | 只有三部分的库：引擎把 FLOW.md 推到最终结果，过程日志实体定义观测记录，文件存储保存这些记录。只依赖 Core 与执行器契约，不持有进程、Socket 与模型配置。 |
| [MCP 服务管理](apps/mcp-web/SPEC.md) | 管理已登记的 Streamable HTTP MCP 服务，提供资源浏览和授权工具调用。独立管理台托管后端库与 Web 页面，两者也可嵌入其他宿主。 |
| [沙箱平台](apps/ursi-sandbox/SPEC.md) | Builder 构建镜像和服务包，注册表校验组合，容器内 Runtime 装配服务。Gateway 管理实例、工作卷和端点，Observer 可选配。 |

## 模块关系

- **查看待办。** SUMM-Todo 看板由自己的 Rust 服务托管 React 页面并提供同源 API，读写 `~/.ursi/todo/todo.db`。项目路径是[位置契约](packages/location/SPEC.md)的 URI，可以指向远程设备。看板自己不访问文件系统：选目录器的数据来自 fs-web 的 `browse`，「在此打开终端」来自 ssh-web，都由组合根注入，它的服务端没有浏览路由也没有 ssh 调用。
- **连上主机。** SSH 终端由自己的 Rust 服务托管页面并提供同源 API 与 WS 桥，读写 `~/.ursi/ssh/ssh.db`，同样不依赖 ursi-flow 的其他模块。它也以 `@ursi/ssh-web/module` 接入 [工作区外壳](packages/workspace-shell/SPEC.md) 成为独立一栏，服务与数据归属不变。
- **管文件。** [fs-web 文件管理器](apps/fs-web/SPEC.md) 由零依赖 Node 服务托管页面并提供同源 API，目录清单存本机状态文件。本机目录直接读写；远程目录只认位置 URI 里的设备名，向 ssh-web 查询连接参数后以 `ssh` 在远端执行，自己不保存任何凭据。它以 `@ursi/fs-web/module` 接入工作区外壳，组合根把 ssh-web 的设备清单与「在此打开终端」两条命令注入给它。
- **看清出站路由。** dae 路由观察台由零依赖 Node 服务托管页面，按 dae native API 读取本机代理状态，不持有自己的数据；连接与流记录留在 dae 进程内存，重启即丢。配置采用 dae 的 managed layout，写入由 dae 自己完成，本服务只注入 token、编排校验与等待热加载。
- **推进一次 Flow。** [Flow Runtime](apps/ursi-flow/runtime/SPEC.md) 的引擎读 FLOW.md，把每一步渲染好的提示词交给执行器，校验回执后交给 Flow Core 选边，并把过程写成日志实体与可恢复快照。
- **在浏览器里跑 Flow。** [Flow 工作台](apps/flow-web/SPEC.md) 的服务端读用户 flow home 里的 `FLOW.md`，用 `apps/ursi-flow` 的引擎开跑并保存运行。flow home 是位置 URI，只接受本机，因为引擎在工作台所在机器上执行，执行器契约没有设备维度；页面负责选包、填变量、回答人工确认与看过程日志。运行事实归工作台状态目录，Flow 包本身只读。它同时是工作区外壳里的 `flow` 模块，通过组合根注入的文件模块命令打开 Flow 目录。
- **执行一个 Flow 包。** [ursi-flow](apps/ursi-flow/SPEC.md) 把 Core、执行器与 Runtime 装配成一次运行：`runFlow` 负责装配与确认问答，命令行负责加载包、传变量与打印结果。执行器只实现 `prompt` 与 `command` 两个方法，换成真实 Agent 时其他模块不动。
- **在浏览器里用 Pi。** Pi Web 一个进程同时管三件事：配置（与 CLI 读同一份 pi home，靠文件级乐观锁与备份互不覆盖）、对话（装配常驻运行时，SSE 推流，扩展 UI 请求转成会话内确认）、会话浏览（任意根目录的 `.jsonl` 都能看，写操作只有删除文件与记录特别关注）。三者共用一份会话实体表：对话写进来的会话立刻出现在浏览列表里，历史会话可以在同一实体上续聊，运行态（含其它进程的心跳）挂在实体的 `runtimes` 上。启动/终止只涉及一个单元，页面与接口同源，工作台通过 `/api/pi` 前缀接入。
- **使用沙箱。** 外部调用方通过 Gateway 打开已登记的 SSH、浏览器或 ACP 等端点，业务会话由对应服务持有。现行 Flow 的命令和 Pi 节点直接在本机工作目录运行，无需 Gateway。

## 设计索引

设计统一放在 [`docs/design/`](docs/design/)，按所属模块分组。新增设计在本页登记。模块功能与验收见各 `SPEC.md`，协议和部署说明随所属模块维护。

| 主题 | 设计文档 |
| --- | --- |
| 位置契约 | [URI 形态、基座边界与分步落地](docs/design/location/URI-CONTRACT.md) |
| SUMM-Todo 看板 | [布局、拖拽与数据流](docs/design/todo-web/DASHBOARD.md) · [工作区外壳与模块组合](docs/design/todo-web/WORKSPACE-SHELL.md) |
| fs-web 文件管理器 | [分阶段范围与关键决策](apps/fs-web/README.md) · [HTTP 契约](apps/fs-web/server/HTTP.md) |
| Pi Web | [接口与状态机契约](apps/pi-web/HTTP.md) · [配置视图布局骨架](docs/design/pi-web/CONFIG-LAYOUT.md) · [单一侧栏](docs/design/pi-web/SINGLE-SIDEBAR.md) |
| SSH 终端 | [接入工作区外壳](docs/design/ssh-web/WORKSPACE-INTEGRATION.md) |
| dae 路由观察台 | [同源代理、页面结构与刷新策略](docs/design/dae-web/OVERVIEW.md) |
| Pi Web 架构 | [领域模型、状态机与实体契约](docs/design/pi-web/OVERVIEW.md) |
| Flow Core | [Flow Core SDK 设计](docs/design/flow-runtime/FLOW-CORE.md) |
| ursi-flow 交付包 | [引擎、日志实体与日志存储](docs/design/flow-runtime/RUNTIME.md) |
| Flow 工作台 | [接口、页面与数据归属](apps/flow-web/README.md) |
| Flow 能力 | [Agent 会话](docs/design/flow-runtime/ability/agent-harness.md) · [运行时工具](docs/design/flow-runtime/ability/runtime-tools.md) · [命令执行](docs/design/flow-runtime/ability/command-execution.md) · [并行执行](docs/design/flow-runtime/ability/parallel-execution.md) · [用户确认门禁](docs/design/flow-runtime/ability/user-confirmation.md)（[实现改动](docs/design/flow-runtime/ability/user-confirmation-impl.md)） |
| MCP 服务管理 | [识别规则与标签](docs/design/mcp-web/RECOGNITION-RULES.md) |
| 沙箱平台 | [构建、实例与端点](docs/design/ursi-sandbox/SANDBOX-PLATFORM.md) · [网络观测页面](docs/design/ursi-sandbox/NETWORK-OBSERVATION.md) · [控制台接入工作区](docs/design/ursi-sandbox/WORKSPACE-INTEGRATION.md) |
| 单机部署 | [入口、路由与发布流程](docs/design/deployment/DEPLOYMENT.md) |

相关入口：[根规格](SPEC.md) · [Flow 导读](apps/ursi-flow/docs/flow-overview.md) · [Flow 文件规范](apps/ursi-flow/docs/flow-spec.md)。
