# 沙箱资源控制台

`/sandboxes` 提供 Gateway 实例管理。管理员可通过快速创建表单填写常用字段，页面会自动组装符合 SandboxSpec 规范的 JSON；也可切换到 JSON 编辑直接提交完整规格。创建后可在详情页启动、停止或确认删除实例，请求受理后页面轮询最终状态。可按状态筛选，按名称（`labels.name`）、ID 或镜像搜索。实例详情展示资源配额、代际、端点快照和最近 200 行日志。刷新按钮重新查询当前数据。

## 独立预览

在本目录使用 Node.js 22.16 或更高版本：

```bash
npm ci
npm run build
npm start
```

打开 `http://localhost:4180/sandboxes`。未配置 Gateway 时显示带“演示数据”标记的本地样例；开发时 `npm run dev` 也可预览样例。交付文件为 `dist/` 和同级 `server.mjs`，启动命令为 `node server.mjs`，运行时只需 Node.js。`PORT` 可调整监听端口。

## 静态交付

页面采用 React 19、TypeScript、React Router、Tailwind CSS 3、Vite 和 shadcn/ui 组件模式。`src/shared/ui/` 内的 Button、Input、Select、Textarea、Label、Badge、Dialog、Collapsible、Alert 基于 Radix UI、CVA 和 Tailwind 封装，业务页面直接使用这些组件。`npm run build` 先做类型检查，再将 HTML、CSS、脚本及配置输出到 `dist/`。只需将其内容发布到静态目录，例如 `/apps/sandbox/`，即可在 `/apps/sandbox/#/sandboxes` 预览演示实例。资源路径相对于入口目录；详情使用 hash 路由，直接打开或刷新均无需配置 SPA 回退。

`src/tokens.css` 保存 Workbench 主题变量的独立副本；同源时读取其 `ursi-flow:theme` 和 `ursi-flow:palette` 偏好。构建不依赖 Workbench 源码。静态产物只包含演示数据。需要连接 Gateway 时可使用自带服务，也可由部署方在同一目录下提供 `console-config.json`（`{"mode":"gateway"}`）并将能力查询及实例请求交给鉴权代理。管理身份的配置额外返回 `manage:true`，代理须按身份及方法再次鉴权。Gateway 管理密钥只配置在代理端。

## 查看真实沙箱

先启动 [Gateway](../gateway/README.md)。为控制台进程设置以下环境变量，重新运行 `npm start`，浏览器使用 `admin` 或 `viewer` 登录。至少配置一种 Web 身份。

| 变量 | 用途 |
| --- | --- |
| `URSI_GATEWAY_URL` | 受信的 Gateway 地址，例如 `http://127.0.0.1:8899` |
| `URSI_GATEWAY_KEY` | 已配置给该 Gateway 的管理密钥，仅保存在服务端 |
| `URSI_WEB_PASSWORD` | 可选。`viewer` 只读密码，至少 16 个字符 |
| `URSI_WEB_ADMIN_PASSWORD` | 可选。`admin` 管理密码，至少 16 个字符，必须与查看密码和 Gateway 密钥不同 |
| `URSI_WEB_TLS_CERT` / `URSI_WEB_TLS_KEY` | 直接对外提供 HTTPS 时使用的证书和私钥文件路径 |

查看者可读取整个命名空间的规格及日志。管理员可操作整个命名空间。管理模式无 TLS 证书时只监听 `127.0.0.1`，可配合 HTTPS 反向代理或 SSH 端口转发；配置证书后监听 `0.0.0.0`。HTTP Basic 凭据需要受保护的传输链路。对外提供访问时，在 HTTPS 反向代理后运行，并限制控制台端口的直接访问。真实模式连接失败会显示错误，不切换到演示数据。

### CLI 对照

`gateway list/create/status/start/stop/delete/endpoints` 分别对应实例列表、创建规格以及详情的状态、操作与服务端点。端点读取自 Gateway 的实例快照。SSH/SFTP 工作区访问、ACP 会话命令使用独立身份，仍通过 [CLI](../client/README.md) 执行。

## 测试

```bash
npm test
npx playwright install chromium
npm run test:e2e
```

`tests/live-management.mjs` 会在专用 Docker 命名空间实际创建、启停并删除 `alpine:3.22` 实例。设置 `URSI_TEST_WEB_URL` 为管理页、`URSI_TEST_ADMIN_FILE` 为管理密码文件后执行 `node tests/live-management.mjs`。使用自签证书时，`URSI_TEST_CERT_PIN` 指定经核实的证书 SPKI SHA-256（Base64）。
