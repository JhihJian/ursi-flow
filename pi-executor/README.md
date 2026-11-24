# Pi 执行器界面演示

独立的静态前端，直接复制自 [Pi Web 静态演示版](https://github.com/agegr/pi-web/tree/432366bd510c72ce7b678a6cb1220f9cac1ed56c/demo)。原界面、样式、图标和交互脚本随模块保留。上游版本见 [`upstream.json`](upstream.json)，使用 [MIT 许可证](LICENSE)。

## 运行

在 Node.js 22.19 或更高版本下运行：

```bash
cd pi-executor
npm ci
npm run dev
```

打开 <http://localhost:30143>。用 `npm run build` 生成静态目录 `out/`，预览时由普通静态文件服务提供该目录。部署到子路径时，可在构建前设置 `PAGES_BASE_PATH`，例如 `PAGES_BASE_PATH=/pi-executor npm run build`。构建使用 Pi Web 原版 Noto Sans Mono 字体。

## 数据与运行边界

`mock/` 在浏览器内响应 `/api/*` 请求和模拟事件流。发送消息、执行工具、打开终端和查看设置使用样例交互。`public/demo-files/manifest.json` 和 `f/` 保存固定上游提交的教程文件子集，包含欢迎页 README、代码预览与差异所需的文件。构建不会扫描宿主仓库。

请在独立页面运行本模块。浏览器内的模拟器会替换所在页面的 `fetch` 和 `EventSource`，真实任务仍由现有执行器平台处理。
