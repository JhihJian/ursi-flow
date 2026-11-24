# Pi Web 前端

这是基于 [Pi Web 静态演示版](https://github.com/agegr/pi-web/tree/432366bd510c72ce7b678a6cb1220f9cac1ed56c/demo) 的独立前端。`/` 提供上游模拟会话、文件和终端交互，`/live/` 连接 [Pi SDK 会话服务](session-service/README.md)。两页共用 Pi Web 的布局、侧栏、消息区、输入区、文件面板和外观设置，沿用同一套字体和图标。上游版本见 [`upstream.json`](upstream.json)，使用 [MIT 许可证](LICENSE)。

## 构建与部署

在 Node.js 22.19 或更高版本下运行：

```bash
cd pi-executor
npm ci
npm run build
```

用静态文件服务托管 `out/`。若部署到子路径，构建时设置 `PAGES_BASE_PATH`，例如 `PAGES_BASE_PATH=/pi-executor npm run build`。本地开发运行 `npm run dev`，默认端口为 `30143`。

演示页只需静态文件。实时页还需要同源的 `/api/pi/`。反向代理保留 API 路径和 Web 入口的 `Host`，对 SSE 关闭响应缓冲和缓存。即使前端部署到子路径，API 仍位于域名根路径下。会话服务也可直接托管根路径构建的 `out/`。

## 打开实时会话

打开受信入口的 `/live/` 直接进入工作区，使用 `/live/?session=<id>` 可直达会话。部署时通过 `PI_SESSION_WEB_ORIGIN` 指定入口地址，将 `PI_SESSION_WEB_ACCESS` 设为 `read` 或 `write`。入口的访问范围由受信网络或上游网关控制，详见[服务配置](session-service/README.md)。

只读入口可查看历史、当前输出和工具结果。可写入口还可新建会话、发送文本和停止运行。实时页的文件面板显示空态。刷新页面或网络重连时，实时页通过只读订阅获取当前快照。
