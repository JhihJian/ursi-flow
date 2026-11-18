# Flow 工作台

工作台连接同源服务的 `/api/v1`。Flow 包、运行和配置都以服务端数据为准。侧栏的「本地演示 → 对话」单独使用浏览器里的示例数据。

## 启动

在 `web/` 下使用 Node.js 24：

```sh
npm ci
npm run dev
```

打开 `http://localhost:5173`，在登录框输入管理员配置的 API token。只输入令牌本身，无需 `Bearer ` 前缀。登录后可刷新或直接打开详情地址，退出登录会清除当前标签页的令牌。请通过 HTTPS 或可信的本机连接访问工作台。

开发服务默认将 `/api/v1` 转发到 `http://127.0.0.1:8080`，可通过 `URSI_API_PROXY` 修改目标。生产环境使用 `npm run build` 生成的 `dist/`，在与 API 同源的位置提供静态内容，仅对前端路由启用 SPA 回退。令牌通过请求头传递，不写入 URL 或构建配置。

## 操作

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
