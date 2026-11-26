# Flow 工作台

工作台连接同源服务的 `/api/v2`（工作清单、包目录、资源和执行器定义、平台 MCP 服务）和 `/api/v1`（Flow 工具）。登录后从侧栏「工作」进入全部事项，也可切换到项目，再进入项目地图、画布或待办。侧栏的「本地演示 → 对话」单独使用浏览器里的示例数据。

## 页面

| 页面 | 作用 |
| --- | --- |
| `/work-items` | 默认首页。新建或编辑事项，按类别（一次性工作、持续工作）和状态（待开始、进行中、已完成）组合筛选。在工作项详情按已保存的配方生成工作包。 |
| `/work-patches`、`/config-patches` | 新建工作包并整理文件，或编辑配置包中的提示词、Skills 和 MCP 配置。 |
| `/resources`、`/executors` | 发布资源与执行器定义，查看历史修订及固定版本的资源依赖。 |
| `/mcp-servers` | 登记获准的 MCP 服务并发现资源，供工作项配方选择。 |
| `/mcp-servers/:id` | 浏览单个服务的资源：左栏按名称或 URI 搜索，右栏读取并预览原文，选中资源记在 `uri` 查询参数里。 |
| `/flows`、`/runs`、`/flow-config` | Flow 工具，保留原有深链。 |
| `/chat` | 本地演示对话，不使用令牌也不调用模型。 |

## 启动

在 `web/` 下使用 Node.js 24：

```sh
npm ci
npm run dev
```

打开 `http://localhost:5173`，在登录框输入管理员配置的 API token。只输入令牌本身，无需 `Bearer ` 前缀。登录后可刷新或直接打开详情地址，退出登录会清除当前标签页的令牌。

### 局域网访问

开发服务与 `vite preview` 都监听 `0.0.0.0`，同一网段的手机和电脑可直接用本机地址打开，例如 `http://192.168.1.20:5173`。Vite 默认只放行 IP 和本机名，用 mDNS 名（`主机名.local`）或自建域名访问时需在命令前加 `URSI_ALLOWED_HOSTS`，多个主机名用逗号分隔，子域用 `.example.com` 形式：

```sh
URSI_ALLOWED_HOSTS=workbench.lan,.example.com npm run dev
```

除明示的主机名以外仍会被 403 拒绝，不接受任意来源的主机头。页面本身不发行令牌，登录仍在浏览器里输入；局域网 HTTP 明文传输令牌，只应在可信网段使用，否则请在前面套一层 HTTPS 反向代理。复制按钮在明文 HTTP 下自动改用选中文本方式，不依赖只在 HTTPS 可用的 Clipboard API。

开发服务默认将 `/api/v1` 与 `/api/v2` 转发到 `http://127.0.0.1:8080`，可通过 `URSI_API_PROXY` 修改目标；`vite preview` 提供构建产物时使用同一套代理。生产环境使用 `npm run build` 生成的 `dist/`，由独立的静态服务提供页面，并通过反向代理将同源 `/api` 请求转发给 Server，仅对前端路由启用 SPA 回退。Server 不提供静态资源。令牌通过请求头传递，不写入 URL 或构建配置。

### 隔离样例预览免登录

`lan-preview` 只开放工作清单和项目规划，包括地图、画布和 Todo。受信网段内的访客都可编辑样例数据。使用独立的 Workbench Server 与数据目录，关闭 Flow，并将 API 绑定到 IPv4 回环地址。服务令牌文件应仅对服务账户可读（`0600`），放在静态目录外。

```sh
npm run build -- --mode lan-preview
URSI_API_PROXY=http://127.0.0.1:18201 \
URSI_LAN_PREVIEW_ORIGIN=http://192.168.1.135:4281 \
URSI_LAN_PREVIEW_CIDR=192.168.1.0/24 \
URSI_LAN_PREVIEW_TOKEN_FILE="$HOME/.local/state/workbench-preview/access-token" \
npx vite preview --mode lan-preview --host 0.0.0.0 --port 4281 --strictPort
```

此模式生成独立的 `dist-lan/`。只通过配置的 IPv4 地址和端口直接访问，转发头不参与来源判断。代理从私有文件读取令牌并转发给回环 API。普通开发、静态部署与预览继续使用默认的 `dist/` 和令牌登录。

## 执行器平台接入

在部署后的 `index.html` 中设置管理入口，无需重新编译：

```html
<meta name="ursi-executor-management-url" content="https://executor.example.org/console/" />
```

填入专有管理页面地址后，桌面侧栏与移动抽屉中的配置包、资源、执行器与后端入口合并为「执行器管理平台」。留空时使用内置的同一套管理页面。此设置只改变导航，不传递登录令牌。Workbench 的 `/api/v2` 请求始终发送到本源，由 Workbench Server 按部署配置代理给平台；`URSI_API_PROXY` 应指向 Workbench Server。平台管理页的构建与部署见[独立入口说明](../../executor-platform/web/README.md)。

在「工作包 → 运行工作包」选启用的执行器和已发布的 Agent 修订，由 Workbench 处理当前包的材料并打开服务返回的尝试详情。

## 操作（Flow 工具）

| 页面 | 操作 |
| --- | --- |
| `/flows` | 创建包，打开已有包，维护 `FLOW.md` 及 `references/`、`scripts/` 内的文本文件。验证检查完整草稿，保存才发布新版本。删除前需要确认。 |
| `/flows/:id/edit` | 查看 revision，修改并保存完整包。保存冲突时保留当前输入，可复制草稿后刷新读取最新版本。填入变量 JSON 和可选 Run ID，启动已保存的 Flow。 |
| `/runs`、`/runs/:id` | 查阅运行状态、参数、配置及历史，停止正在运行的任务。 |
| `/flow-config` | 查看执行器，调整默认模型和最大并发数（1 至 64）。 |
| `/chat` | 使用本地示例会话，体验流式回复、停止、重新生成和 Markdown 展示。对话不使用 API token，不调用模型或读取真实运行数据。 |

## 验证

```sh
npm run check
npx playwright install chromium
npm run test:e2e
```

`check` 包含 ESLint、Vitest、TypeScript 和生产构建。Playwright 在桌面及移动视口拦截 HTTP，检查鉴权、方法、路径、请求体、响应渲染与冲突状态。真实服务联调时，将 `URSI_API_PROXY` 指向目标实例并使用其令牌。

### 真实浏览器联合验收

先在 `workbench/` 构建 Server，再从 `web/` 依次运行两套验收。两者共用回环端口和临时运行目录。

```sh
(cd .. && cargo build --locked -p ursi-server)
npm run test:acceptance
npm run test:patches-acceptance
```

[定义验收](acceptance/README.md)在桌面和移动浏览器中发布提示词和执行器，再从旧版深链读取固定资源。[工作包与配置包验收](patches-acceptance/README.md)验证清单、MCP 配方生成和包文件编辑；生成需要 Server 所在主机具备 [Python 隔离环境](../server/src/work/mcp/PLATFORM.md)。两套验收均不需要 Pi 或模型。
