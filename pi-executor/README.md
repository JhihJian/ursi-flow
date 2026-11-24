# Pi Web 前端

Pi Web 的首页 `/` 列出 [Pi SDK 会话服务](session-service/README.md) 中的会话。选中会话后，可通过链接打开四个独立页面。前端沿用上游 Pi Web 的主题、字体和消息组件。上游版本见 [`upstream.json`](upstream.json)，使用 [MIT 许可证](LICENSE)。

## 构建与部署

在 Node.js 22.19 或更高版本下运行：

```bash
cd pi-executor
npm ci
npm run build
```

用静态文件服务托管 `out/`。若部署到子路径，构建时设置 `PAGES_BASE_PATH`，例如 `PAGES_BASE_PATH=/pi-executor npm run build`。本地开发运行 `npm run dev`，默认端口为 `30143`。

工作区通过同源的 `/api/pi/` 访问会话服务。反向代理保留 API 路径和 Web 入口的 `Host`，对 SSE 关闭响应缓冲和缓存。前端部署到子路径时，API 仍位于域名根路径下。会话服务也可直接托管根路径构建的 `out/`。

## 会话目录与独立页面

首页 `/` 可按标题或 ID 查找会话。可写用户可从首页新建会话，新建后进入提示词页。各页使用固定路由，链接中的 `<id>` 为会话服务返回的 ID。

| 页面 | 路径与源码目录 | 用途 |
| --- | --- | --- |
| 对话 | `/conversation/?session=<id>`，`app/conversation/` | 只读查看消息、实时输出和工具结果。附加 `&entry=<id>` 可直达历史快照。 |
| 运行配置 | `/runtime/?session=<id>`，`app/runtime/` | 查看模型、系统提示、工具、已加载技能和 MCP。不带会话 ID 时显示服务默认值。 |
| 会话结构 | `/structure/?session=<id>`，`app/structure/` | 查看消息轨迹、分支和父子会话，可打开历史快照。可写用户可从选中的消息派生子会话。 |
| 提示词 | `/prompt/?session=<id>`，`app/prompt/` | 可写用户在此发送文本和停止运行。通过链接打开对话查看输出。 |

部署时用 `PI_SESSION_WEB_ORIGIN` 指定受信入口，用 `PI_SESSION_WEB_ACCESS` 设置 `read` 或 `write`。网络或网关负责控制入口的访问范围，详见[服务配置](session-service/README.md)。只有显式发送提示词才启动 Agent 并调用模型。当前服务未加载技能或 MCP，相关页面显示空态。
