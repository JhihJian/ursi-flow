# Pi Web 前端

这是基于 [Pi Web 静态演示版](https://github.com/agegr/pi-web/tree/432366bd510c72ce7b678a6cb1220f9cac1ed56c/demo) 的独立前端。`/` 保留上游模拟会话、文件和终端交互；`/live/` 复用 Pi Web 的消息和输入组件，连接 [Pi SDK 会话服务](session-service/README.md)。上游版本见 [`upstream.json`](upstream.json)，使用 [MIT 许可证](LICENSE)。

## 构建与部署

在 Node.js 22.19 或更高版本下运行：

```bash
cd pi-executor
npm ci
npm run build
```

用静态文件服务托管 `out/`。若部署到子路径，构建时设置 `PAGES_BASE_PATH`，例如 `PAGES_BASE_PATH=/pi-executor npm run build`。本地开发运行 `npm run dev`，默认端口为 `30143`。

演示页只需静态文件。实时页还需要同源的 `/api/pi/`：静态服务器所在的代理将该前缀转发给会话服务，保留 API 路径和 `Authorization` 请求头，对 SSE 关闭响应缓冲和缓存。即使前端部署到子路径，API 仍位于域名根路径下。合并部署时，会话服务也可直接托管根路径构建的 `out/`。

## 打开实时会话

访问 `/live/` 并输入会话令牌。会话列表可手动刷新；外部系统可直接分享 `/live/?session=<id>`。链接只包含会话 ID，访问权限由令牌决定。

对话令牌可新建会话、发送文本和停止运行。只读令牌可查看历史、当前输出和工具结果。令牌在当前标签页的会话存储中保留，点击「断开」将其清除。刷新页面或网络重连时，实时页从服务端重新订阅当前快照。
