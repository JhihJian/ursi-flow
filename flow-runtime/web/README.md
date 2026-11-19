# Flow 控制台

`flow-runtime/web` 是 Runtime 的独立控制台。操作者不经工作台和 CLI 就能维护 Flow 包、启动和停止运行、查看节点与路由证据、修改执行配置。页面使用 React 19、TypeScript、React Router、Tailwind CSS 3、shadcn 组件和 Vite，构建产物是静态文件，可单独发布，也可嵌入工作台。

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
| `URSI_FLOW_WORKDIR` | `default` 工作区的目录，启动运行前解析为真实路径；缺失时进入演示模式 |
| `URSI_FLOW_HOME` | 可选，daemon 的私有目录，默认 `~/.ursi-flow`，读取其中的 `runtime.sock` |
| `URSI_FLOW_WEB_HOSTS` | 可选，允许的额外域名（逗号分隔）；IP 与 `localhost` 始终允许 |
| `HOST` / `PORT` | 可选，监听地址与端口，默认 `0.0.0.0:4181` |

```sh
URSI_FLOW_WORKDIR="$PWD" npm start
```

`server.mjs` 把同源 `/api/v1` 请求翻译成 daemon 的一次 Unix socket 请求，浏览器不直接接触 socket。页面不做访问令牌验证，因此服务默认只接受 IP 字面量、`localhost` 或 `URSI_FLOW_WEB_HOSTS` 登记的域名作为 Host，并只接受同源页面发起的写请求，避免其他站点借浏览器改写本机数据。需要 HTTPS 时配置 `URSI_FLOW_WEB_TLS_CERT` 和 `URSI_FLOW_WEB_TLS_KEY`。daemon 故障返回 503 或 504，页面显示错误，不会退回演示数据。

运行中的 Run 使用同一份历史：控制台和 `ursi-flow run history` 查询到的节点、路由和命令输出一致。

## 静态交付与嵌入

`npm run build` 先做类型检查，再输出 `dist/`。把内容发布到静态目录（例如 `/apps/flow/`）即可在 `/apps/flow/#/flows` 打开演示。资源路径相对入口，路由使用 hash，直接打开或刷新详情都不需要 SPA 回退。

入口同级需要一个 `console-config.json`，静态预览由 `public/console-config.json` 提供：

```json
{"mode":"demo"}
```

实时模式由 `server.mjs` 动态返回，也可以由宿主站点提供：

```json
{"mode":"live","apiBase":"/api/v1","workspace":{"name":"default","path":"/srv/project"}}
```

嵌入工作台时复用同一份 `dist/`：`apiBase` 指向工作台的 `/api/v1`，页面只发送 `workspace: "default"`，认证交给工作台自己的会话。工作台需要提供 `flows`、`flows/validate`、`flows/:id`、`flows/:id/runs`、`runs`、`runs/:id`、`runs/:id/history`、`runs/:id/stop`、`flow-config` 这几组接口，请求与响应形状与本目录 `server.mjs` 相同。`workspace` 只作展示时可省略。

## 图形视图

编辑页打开 `FLOW.md` 时只有图形与文档两个视图，没有源码视图；`references/` 下的 Markdown 用文档视图，`scripts/` 下的脚本用脚本视图。图形视图说明如下。

编辑页默认打开图形视图：`FLOW.md` 的 Mermaid 图被画成节点卡片，右侧每行是一个结果出口。画布自左向右分层，连线来自 dagre 的路由折点，会绕开卡片；返工、重试这类回边不进分层，从图形下方绕回。节点位置与缩放只存在界面状态里，不写回 `FLOW.md`，点“自动布局”可以随时恢复分层位置。

## 运行前提

页面只负责提交运行，Agent 节点由 daemon 用 Pi SDK 在进程内执行，模型接入信息来自 daemon 的 `~/.ursi-flow/config.json`。首次使用先在“运行配置”页填模型服务地址、密钥和模型标识，保存后即可启动。provider 缺项时页面会禁用“启动运行”并说明缺什么，不依赖任何机器的 `PATH`、环境文件或固定模型。

## 启动参数

点“启动运行”会先弹出参数框。表单按 `FLOW.md` 元信息里的全局变量声明生成：名称、用途说明、必填或可选，带 `default` 的可以留空使用默认值。参数在浏览器里转成 JSON 提交，没有额外接口。

节点执行中自己写入的变量不算启动参数：结果变量表里声明过的名字，以及节点正文里用 `variables.x` 或「全局变量 `x`」写回的名字都按运行时状态处理；这类变量带默认值时只在参数框底部列出名称与初始值。原始 JSON 留在同一个框里作为高级入口，未声明的名字和缺少的必填项都会在提交前拦下。

## 测试

```sh
npm test
npx playwright install chromium
npm run test:e2e
```

`npm test` 用临时目录里的假 daemon 覆盖协议映射、认证、错误码、请求上限和静态路径。`npm run test:e2e` 先构建 Runtime，再用真实 daemon 完成建包、校验、运行、停止、配置与冲突的闭环，并覆盖子目录静态演示与窄屏布局。`dist/`、`node_modules/` 与端到端临时目录不在版本库中。

`flow-runtime` 的 npm 包只包含引擎（`dist/`、`docs/`、`examples/`），不含本目录。
