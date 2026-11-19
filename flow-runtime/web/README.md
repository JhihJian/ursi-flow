# Flow 控制台

`flow-runtime/web` 是 Runtime 的独立控制台。操作者不经工作台和 CLI 就能维护 Flow 包、启动和停止运行、查看节点与路由证据、修改执行配置。页面使用 React 19、TypeScript、React Router、Tailwind CSS 3 和 Vite，构建产物是静态文件，可单独发布，也可嵌入工作台。

## 独立预览

在本目录使用 Node.js 22.19 或更高版本：

```sh
npm ci
npm run build
npm start
```

打开 `http://127.0.0.1:4181/#/flows`。未配置 Runtime 时显示带“演示数据”标记的本地样例：两个 Flow 包、四条运行记录和一份配置。演示模式不发起 `/api` 请求，也不能写入。开发时 `npm run dev` 预览同一份样例。

## 连接本机 Runtime

先启动 `ursi-flowd`，再为控制台设置三个变量并重新运行 `npm start`：

| 变量 | 用途 |
| --- | --- |
| `URSI_FLOW_WEB_TOKEN` | 浏览器访问控制台时输入的令牌，至少 16 个字符；缺失时进入演示模式 |
| `URSI_FLOW_WORKDIR` | `default` 工作区的目录，启动运行前解析为真实路径 |
| `URSI_FLOW_HOME` | 可选，daemon 的私有目录，默认 `~/.ursi-flow`，读取其中的 `runtime.sock` |

```sh
URSI_FLOW_WEB_TOKEN='请替换为长令牌' URSI_FLOW_WORKDIR="$PWD" npm start
```

`server.mjs` 把同源 `/api/v1` 请求翻译成 daemon 的一次 Unix socket 请求，浏览器不直接接触 socket。令牌只保存在标签页的 `sessionStorage`。配置令牌但未配置 TLS 时只监听 `127.0.0.1`；直接对局域网提供服务需要 `URSI_FLOW_WEB_TLS_CERT` 和 `URSI_FLOW_WEB_TLS_KEY`，此时监听 `0.0.0.0` 并用 HTTPS。daemon 故障返回 503 或 504，页面显示错误，不会退回演示数据。

运行中的 Run 使用同一份历史：控制台和 `ursi-flow run history` 查询到的节点、路由和命令输出一致。

## 静态交付与嵌入

`npm run build` 先做类型检查，再输出 `dist/`。把内容发布到静态目录（例如 `/apps/flow/`）即可在 `/apps/flow/#/flows` 打开演示。资源路径相对入口，路由使用 hash，直接打开或刷新详情都不需要 SPA 回退。

入口同级需要一个 `console-config.json`，静态预览由 `public/console-config.json` 提供：

```json
{"mode":"demo"}
```

实时模式由 `server.mjs` 动态返回，也可以由宿主站点提供：

```json
{"mode":"live","auth":true,"apiBase":"/api/v1","workspace":{"name":"default","path":"/srv/project"}}
```

嵌入工作台时复用同一份 `dist/`：`apiBase` 指向工作台的 `/api/v1`，页面只发送 `workspace: "default"`，令牌使用与工作台相同的 `ursi-flow:bearer` 会话键。工作台需要提供 `flows`、`flows/validate`、`flows/:id`、`flows/:id/runs`、`runs`、`runs/:id`、`runs/:id/history`、`runs/:id/stop`、`flow-config` 这几组接口，请求与响应形状与本目录 `server.mjs` 相同。`workspace` 只作展示时可省略。

## 测试

```sh
npm test
npx playwright install chromium
npm run test:e2e
```

`npm test` 用临时目录里的假 daemon 覆盖协议映射、认证、错误码、请求上限和静态路径。`npm run test:e2e` 先构建 Runtime，再用真实 daemon 完成建包、校验、运行、停止、配置与冲突的闭环，并覆盖子目录静态演示与窄屏布局。`dist/`、`node_modules/` 与端到端临时目录不在版本库中。

`flow-runtime` 的 npm 包只包含引擎（`dist/`、`docs/`、`examples/`），不含本目录。
