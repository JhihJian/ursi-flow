# 沙箱控制台接入工作区

在 `shell-web` 中增加原生 **Sandbox** 模块栏：从栏内筛选和选择实例，在中央查看详情和使用端点工作台，在右侧执行当前实例的管理操作。`apps/ursi-sandbox/web` 保留业务源码、独立控制台和服务端代理。两种入口使用同一套视图与客户端，连接同一个 Gateway 命名空间。

先在 `apps/ursi-sandbox/web` 内完成一次行为等价的拆分，再把列表、详情、端点状态和按需日志接入 Workspace。通过目标入口验证路由和身份后，再开放管理、网络观测和实时工作台。独立控制台继续承接所有现有操作。

## 前置重构：整理独立控制台

参照 [Todo Web](../../../apps/todo-web/web/src) 的薄入口、API 与视图分层。当前 Sandbox 的 `main.tsx` 同时负责挂载、配置加载、路由、列表和详情。先按下面的边界拆分，只改 `apps/ursi-sandbox/web`。

| 位置 | 职责 |
| --- | --- |
| `src/main.tsx`、`src/App.tsx` | `main` 负责挂载和独立样式，`App` 负责 `HashRouter`、配置加载和页面组装。独立入口继续使用现有 URL。 |
| `src/api/client.ts`、`src/api/types.ts` | 从 `data.ts` 拆出请求与类型。`loadSource` 接收目录基址，默认 `./`，保留现有请求路径、查询串、头和错误语义。 |
| `src/hooks/useLoad.ts` | 管理读取、取消、重试和过期响应，保持失权或资源不存在时清除旧数据。 |
| `src/features/instances/` | 抽出实例列表、详情检查区和按需日志。列表通过回调交出选中 ID，详情按传入的 ID 读取，和当前列表筛选解耦。工作台、管理、观测继续由独立页面组装。 |

筛选留在列表，独立入口的当前实例由路由决定。Workspace 接入后，当前实例由外壳选中决定，两种入口都不需要 Todo 式的全局 store 或挂载时同步选中的逻辑。其他功能文件继续留在原位，服务端、鉴权和界面行为保持原样。

## 固定骨架下的实现形态

外壳改为固定五区后，沙箱模块按下面的形态接入：

- `SandboxSidebar.tsx`：模块导航（沙箱 / 能力注册表 / 接入配置）、Gateway 权限徽标、实例列表与状态筛选；折叠窄条显示实例数与运行数。点击实例通过共享 `MemoryRouter` 切换路由。
- `SandboxWorkspace.tsx`：只渲染路由内容（实例详情、注册表、接入配置、网络观测），不含模块标题与导航。
- `module.tsx` 的 Provider 是 `MemoryRouter` + `SandboxDataProvider`：配置、实例列表与筛选状态只加载一份，侧边栏与工作区共用，路由变化时自动刷新列表。
- 每个区域各包一层 `AppRoot`，`sbx-app` 样式作用域与 Radix 浮层容器都按区域分开，弹窗不会飞到另一个区域。
- 当前不发布 `sandbox.instance` 选中，也不注册 actions；实例导航由路由承担，右侧控制面板在该模块下为空态。管理操作留在详情页内，后续需要跨模块操作时再注册。

下面各节保留目标设计，和上面实现形态冲突处以本节为准。

## 界面分工

| 位置 | 交互 |
| --- | --- |
| Sandbox 模块栏 | 用紧凑列表和状态计数浏览实例，区分空列表、筛选无匹配与读取失败。折叠显示实例数，选中后显示实例名称和状态。创建、能力注册表及接入配置从栏内进入。 |
| 中央工作区 | 选中实例后展示规格、端点和按需日志。工作台开放后承载终端、IDE、桌面和应用预览。能力注册表、接入配置、观测记录注册为独立 `views`，共用中央区域。 |
| 右侧操作栏 | 管理阶段提供启动、停止和「更多操作」。重建和删除从「更多操作」打开现有 Sandbox 确认对话框，同一操作只保留一个入口。 |

按[工作区模块契约](../../../packages/workspace-shell/MODULE-CONTRACT.md)注册 `id: 'sandbox'`。列表点击后发布 `{ kind: 'sandbox.instance', id, label }`，详情按 ID 读取。外壳仍只负责布局、选中和操作分派。Sandbox 模块共享身份、列表和详情数据，模块栏折叠不清除中央选中。管理阶段由宿主根据模块状态更新 `actions`，保持视图组件身份稳定。操作提交前再次核对当前权限和状态。删除等到 Gateway 确认资源不存在后，再清除同一个实例的选中。

宿主负责 `#/sandbox/instances/:id` 与 `#/sandbox/instances/:id/observations/:runId` 等深链。进入、刷新及前进后退时将地址还原为外壳选中，观测视图用实例 ID 和记录 ID 的组合键。地址是选中的可分享表示，模块内不再维护一份当前实例。切换到 Todo、文件或设置时清除对应的 Sandbox 地址。Todo 目前在挂载及任务状态变化时同步选中。接入时只在用户选择任务时发布 Todo 选中，清空时只清除属于 Todo 的选中，保证 Sandbox 深链不会被其他栏的加载覆盖。

## 代码与样式

| 位置 | 接入改动 |
| --- | --- |
| `apps/ursi-sandbox/web/src/features/instances/` | Workspace 复用前置重构产出的列表和详情视图。管理和观测开放时，再将对应页面的导航改为由入口提供的回调。 |
| `apps/ursi-sandbox/web/src/api/` | Workspace 注入 `/api/sandbox/`。探活、观测下载和工作台 WebSocket 随各自功能接入同一基址规则；独立入口继续使用相对于部署目录的基址。 |
| [`shell-web`](../../../apps/shell-web) | 在 `src/registry.tsx` 调用 `createSandboxModule({ apiBase: '/sbx' })` 并写进 profile。构建前分别按仓库根目录和 `apps/ursi-sandbox/web` 的锁文件安装依赖，Workspace 构建去重 `react` 和 `react-dom`。终端、远程画面与 PCAP Worker 随对应功能按需加载。 |

嵌入样式使用 `.sbx-app` 局部规则和语义变量，跟随宿主的灰度与字体基线。Sandbox 自己编译一份带作用域的嵌入样式，保留组件所需的局部基础样式。Tailwind 全局 Preflight 和视口高度只用于独立入口。嵌入版按栏宽切换布局，滚动留在栏内。Radix 浮层挂到当前视图的容器，替换按全局查询取第一个 `.sbx-app` 的方式。

源码接入可以复用全局选中、折叠和操作栏。独立入口适合运维访问及回退，但无法参与这些交互。现有控制台的 `frame-ancestors 'none'` 禁止 iframe 嵌入，保持该策略。首版沿用现有源码目录，与项目门户 `apps/web` 的入口独立演进。

## 服务与身份边界

Workspace 通过同源 `/api/sandbox/` 访问 [Sandbox Web 服务](../../../apps/ursi-sandbox/web/server.mjs)，由该服务访问 Gateway。开发和 Vite preview 用 `SANDBOX_WEB_API` 配置 Sandbox Web 上游，生产由入口反向代理配置。三处都先匹配这个独立前缀，再匹配 Todo 的 `/api`。剥掉前缀后保留原路径、查询串及方法，例如 `/api/sandbox/console-config.json` 转发为 `/console-config.json`。API 响应保留状态码，错误不回落到 HTML。

- **入口和权限。** 只读阶段在代理层仅开放配置、能力、实例列表、详情、端点和日志的读取，工作台 Upgrade 和其他能力按阶段启用。保留 Sandbox 的 `viewer` / `admin` 鉴权和写操作校验，宿主不注入共享管理员身份。首次展开 Sandbox 栏或直达沙箱深链时才访问 Sandbox 服务。透传 `401` 及认证挑战，使用真实浏览器验证登录和身份切换。外层如有鉴权，应与 Sandbox 的 Basic 凭据使用独立通道。Gateway 密钥及 SSH 私钥留在服务端，用户仍在同一个 Gateway 命名空间内操作。
- **共享来源。** 路径只用于分流，同源的 Workspace 和 Sandbox 模块属于同一个信任边界。生产只向受信用户开放组合入口，单独保护默认无鉴权的 [本机文件服务](../../../apps/fs-web/SPEC.md)。宿主页面负责整体 CSP，验证同源脚本、Worker 与 `wss` 连接可用。沙箱应用继续在沙箱内的 Chromium 运行，Workspace 只接收画面。
- **长连接与下载。** 外层代理启用 WebSocket Upgrade，保留对外 `Host` 和浏览器 `Origin`，TLS 在外部终止时将 `URSI_WEB_ORIGIN` 配为实际 HTTPS origin。通过原代理流式转发 PCAP，保留下载头和取消传播。现有详情和观测使用按需轮询，无需新增 SSE。折叠且未选中时停止列表后台加载。实时工作台在切换实例、标签或离开详情时释放连接，同实例同代际的合规连接可跨详情内刷新保留。离开观测视图只取消读取，采集继续运行。

## 分批交付与验收

| 阶段 | 验收门槛 |
| --- | --- |
| 0. 独立控制台重构 | 在 `apps/ursi-sandbox/web` 通过 `npm run build`、`npm test` 和 `npm run test:e2e`。补测子目录及非默认基址的路径前缀、快速切实例不串详情、展开前不读日志。现有管理确认、工作台连接释放及观测失权回归继续通过。 |
| 1. 只读接入 | 从干净依赖完成 Sandbox 独立构建及 Workspace 类型检查和构建。在 Workspace 验证实例筛选、详情、日志、错误重试、深链刷新及前进后退，检查窄栏、折叠和 Todo、文件、Settings 共存。再通过目标入口验证三类 API 分流，未登录收到 Sandbox 的 `401`，viewer 和 admin 可按设计读取，只读入口不接收写操作。 |
| 2. 管理与配置 | 验证创建、启停、重建、删除和确认取消，失败时保留选中并显示错误。用真实 `createConsole` 验证 viewer 被拒绝，admin 仍受原有校验。接入配置上线前修复并回归公钥读取：当前普通 `GET /api/v1/access-keys` 会进入 JSON 请求体分支，返回 `415`。 |
| 3. 工作台与观测 | 在正式同源入口验收管理员 WebSocket 握手、切换释放和代际变化，以及非管理员拒绝。验证观测深链、刷新不重复采集、失权清除数据及离开时取消读取。对比完整 PCAP 与上游原始分段的字节数和 SHA-256。 |

模拟预览用于页面交互和错误态验证。身份、WebSocket 和下载验收使用真实 Sandbox Web 代理，并经 Workspace 的目标代理入口执行。实施时更新 [Sandbox Web 规格](../../../apps/ursi-sandbox/web/SPEC.md)，补齐 Workspace 模块的接入规格、运行说明和自动化验收。
