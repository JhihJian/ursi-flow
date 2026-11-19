# 沙箱资源控制台

`/sandboxes` 提供只读实例列表。可按状态筛选，按名称（`labels.name`）、ID 或镜像搜索。实例详情展示资源配额、代际、端点快照和最近 200 行日志。刷新按钮重新查询当前数据。

## 独立预览

在本目录使用 Node.js 22.16 或更高版本：

```bash
npm ci
npm run build
npm start
```

打开 `http://localhost:4180/sandboxes`。未配置 Gateway 时显示带“演示数据”标记的本地样例；开发时 `npm run dev` 也可预览样例。交付文件为 `dist/` 和同级 `server.mjs`，启动命令为 `node server.mjs`，运行时只需 Node.js。`PORT` 可调整监听端口。

## 静态交付

页面采用 React 19、TypeScript、React Router、Tailwind CSS 3 和 Vite。`npm run build` 先做类型检查，再将 HTML、CSS、脚本及配置输出到 `dist/`。只需将其内容发布到静态目录，例如 `/apps/sandbox/`，即可在 `/apps/sandbox/#/sandboxes` 预览演示实例。资源路径相对于入口目录；详情使用 hash 路由，直接打开或刷新均无需配置 SPA 回退。

`src/tokens.css` 保存 Workbench 主题变量的独立副本；同源时读取其 `ursi-flow:theme` 和 `ursi-flow:palette` 偏好。构建不依赖 Workbench 源码。静态产物只包含演示数据。需要连接 Gateway 时可使用自带服务，也可由部署方在同一目录下提供 `console-config.json`（`{"mode":"gateway"}`）并将 `api/v1/sandboxes` 的只读请求交给鉴权代理。Gateway 管理密钥只配置在代理端。

## 查看真实沙箱

先启动 [Gateway](../gateway/README.md)。为控制台进程设置以下环境变量，重新运行 `npm start`，浏览器登录用户名为 `viewer`。

| 变量 | 用途 |
| --- | --- |
| `URSI_GATEWAY_URL` | 受信的 Gateway 地址，例如 `http://127.0.0.1:8899` |
| `URSI_GATEWAY_KEY` | 已配置给该 Gateway 的管理密钥，仅保存在服务端 |
| `URSI_WEB_PASSWORD` | 独立查看密码，至少 16 个字符 |

查看者可读取整个命名空间的规格及日志。服务监听 `0.0.0.0`，HTTP Basic 凭据需要受保护的传输链路。对外提供访问时，在 HTTPS 反向代理后运行，并限制控制台端口的直接访问。真实模式连接失败会显示错误，不切换到演示数据。

## 测试

```bash
npm test
npx playwright install chromium
npm run test:e2e
```
