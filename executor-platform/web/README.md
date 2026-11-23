# 执行器管理平台

根地址进入 `/agent`，使用 [AI Elements](https://ui.shadcn.com/docs/ai-elements) 的对话、回复和输入组件。选择已发布的 Agent 修订后输入任务指令，可查看实时回复和工具状态、停止尝试、打开只读制品。刷新时查回当前标签页的原尝试。浏览器访问同源平台 API，由平台为每个任务建立独立 ACP v2 会话。组件来源见 [AI Elements 来源](src/ai-elements/PROVENANCE.md)。

`/executors/new?mode=agent` 创建 Agent 草稿，选择配置包与后端后可试跑、查看制品、发布版本。`/config-patches` 维护提示词、Skills 和 MCP，`/resources` 管理固定版本的资源，`/settings/agent-backends` 检查已登记的后端。

## 开发与验证

从仓库根目录用 Node.js 24 安装共享组件的依赖和本应用依赖：

```sh
npm ci --prefix workbench/web
cd executor-platform/web
npm ci
URSI_EXECUTOR_API_PROXY=http://127.0.0.1:8081 npm run dev
```

打开 `http://localhost:5175`，输入平台管理员令牌。开发和预览代理只转发 `/api/v2`。`URSI_EXECUTOR_API_PROXY` 是服务端代理目标，不会写入浏览器的请求地址。平台使用独立的标签页令牌，退出或当前令牌收到 401 后需要重新登录。

```sh
npm run build
npx playwright install chromium
npm test
```

浏览器测试在桌面、移动尺寸打开生产构建，在 HTTP 边界核对登录、同源路径、发布、原尝试恢复、取消和制品读取。真实 Pi ACP 运行见[平台验收](../acceptance/README.md)。

## 部署

在平台域名上提供 `dist/`。将该域名的 `/api/v2/*` 转发到平台服务，前端路由回退到 `index.html`，API 错误保留原响应。HTTPS 用于保护 Bearer 令牌。若 UI 挂在子路径，构建时指定基址，例如 `npm run build -- --base=/console/`；API 仍位于域名根下的 `/api/v2`。

Workbench 的管理导航可指向此入口。业务页面仍向 Workbench 自己的域名发请求，平台服务地址及服务凭据由 Workbench 服务端管理。配置示例见 [Workbench 前端说明](../../workbench/web/README.md#执行器平台接入)。
