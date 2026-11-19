# Flow 工作台

工作台连接同源服务的 `/api/v2`（工作清单、定义、办理与验收）和 `/api/v1`（Flow 工具）。工作包、工作项、交付与验收都以服务端数据为准。侧栏的「本地演示 → 对话」单独使用浏览器里的示例数据。

## 页面

| 页面 | 作用 |
| --- | --- |
| `/items` | 工作清单，默认首页。按全部、待办理、办理中、待验收、已交付筛选；行内可读工作包版本、单号、来源、经办人与状态。 |
| `/items/new` | 从已发布的工作包版本发起待办理工作项，按输入声明填写材料。 |
| `/items/:id` | 办理详情：办理、执行记录、交付与验收三个页签。 |
| `/items/:id/deliveries/:version` | 固定打开某一交付版本，旧版只读并保留退回意见。 |
| `/packages`、`/resources`、`/executors` | 工作包、资源库与执行器目录，可发布新版并查看历史版本。 |
| `/sources` | 管理员配置的外部来源，按固定动作派工进入同一工作清单；未配置时入口收起。 |
| `/flows`、`/runs`、`/flow-config` | Flow 工具，保留原有深链。 |
| `/chat` | 本地演示对话，不使用令牌也不调用模型。 |

## 启动

在 `web/` 下使用 Node.js 24：

```sh
npm ci
npm run dev
```

打开 `http://localhost:5173`，在登录框输入管理员配置的 API token。只输入令牌本身，无需 `Bearer ` 前缀。登录后可刷新或直接打开详情地址，退出登录会清除当前标签页的令牌。请通过 HTTPS 或可信的本机连接访问工作台。

开发服务默认将 `/api/v1` 与 `/api/v2` 转发到 `http://127.0.0.1:8080`，可通过 `URSI_API_PROXY` 修改目标；`vite preview` 提供构建产物时使用同一套代理。生产环境使用 `npm run build` 生成的 `dist/`，由独立的静态服务提供页面，并通过反向代理将同源 `/api` 请求转发给 Server，仅对前端路由启用 SPA 回退。Server 不提供静态资源。令牌通过请求头传递，不写入 URL 或构建配置。

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

用真实 Web（构建产物 + 同源代理）、真实 `ursi-server` 和真实 Pi CLI 验证完整业务链路。只有模型是模拟的：本机固定回复端点。

```sh
npm run test:acceptance
```

该命令自动构建产物、启动隔离的服务与预览实例，跑主场景双单链路、JSON 来源派工与移动视口三个场景，结束后清理临时数据。环境变量、目录结构与限制见 [联合验收说明](acceptance/README.md)，签收结论见 [签收报告](acceptance/REPORT.md)。
