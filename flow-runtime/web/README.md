# Flow 控制台

`flow-runtime/web` 是 Runtime 的独立控制台。操作者不经工作台和 CLI 就能维护 Flow 包、启动和停止运行、查看节点与路由记录、修改执行配置。页面使用 React 19、TypeScript、React Router、Tailwind CSS 3、shadcn 组件和 Vite，构建产物是静态文件，可单独发布，也可嵌入工作台。

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
| `URSI_FLOW_WORKDIR` | `default` 工作区的目录，用于判断是否连接 Runtime 并在页头显示；缺失时进入演示模式。运行实际落在哪个目录由 daemon 的工作区根目录或启动参数决定 |
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

嵌入工作台时复用同一份 `dist/`：`apiBase` 指向工作台的 `/api/v1`，页面只发送 `workspace: "default"`，认证交给工作台自己的会话。工作台需要提供 `flows`（`?detail=1` 返回包摘要）、`flows/validate`、`flows/:id`、`flows/:id/runs`、`runs`、`runs/:id`、`runs/:id/history`、`runs/:id/flow`、`runs/:id/nodes/:nodeId/trajectory`、`runs/:id/stop`、`flow-config` 这几组接口，请求与响应形状与本目录 `server.mjs` 相同。`workspace` 只作展示时可省略。

## 运行的工作目录

启动运行必须先确定工作目录。两种方式：

- **工作区根目录**（推荐）：在「运行配置」里填一个绝对路径，daemon 会把它和 provider 一起保存。启动运行留空工作目录时，daemon 在 `<工作区根目录>/<Run ID>` 新建目录作为这次运行的工作目录，Flow 的脚本与 Agent 都在那里执行。
- **启动时指定**：启动运行对话框里的「工作目录」填一个已存在的绝对路径，这次运行就用它。适合对着已有项目跑。

两者都没有时 daemon 拒绝启动，并在对话框里说明去「运行配置」填工作区根目录。工作目录在启动时固定写入 Run 记录，重试同一 Run ID 时要求 Flow、目录与变量一致，否则返回冲突。

## 列表页

两个列表都是数据表格（`src/components/ui/data-table.tsx`）：TanStack Table 提供模型，标记与样式用本目录的 shadcn `Table`。表头可点击排序，筛选框按关键字匹配，行数超过一页时给出翻页；窄屏隐藏次要列，页面不产生横向滚动。

- **Flow 包**：一次请求 `GET /api/v1/flows?detail=1` 取回每个包的名称、说明、节点数、启动变量数与修订（只返回标识的 `GET /api/v1/flows` 保留给工作台）。解析不了的包占一行并标为「不可用」，不影响其他行。行内提供「编辑」与「删除」，删除前弹确认框，成功后清空筛选并刷新列表；演示模式禁用删除按钮。
- **运行记录**：列出 Run、Flow、状态、修订与工作目录，行内「详情」进入运行页。

删除只作用于当前修订的包目录，已启动的运行仍按各自固定的修订读取历史。

## 运行详情

运行记录详情共用一个页头与两类记录。页头给出运行 ID、状态、Flow 与修订、开始时间与耗时，右侧是「运行参数」「刷新」「停止运行」；下面一行统计节点访问、路由判定、并行轮次与恢复记录。运行参数（工作目录、修订、并发、模型、服务地址与启动变量）收在同名对话框里，不再占正文。

- **Flow 流转**：按运行启动时固定的目录修订读取 `FLOW.md`，画出节点卡片与结果边。未到达、运行中、已完成、失败与中断的节点用不同状态标记，当前节点带呼吸环；实际走过的结果边实线高亮，没走过的边淡显。点节点跳到该节点最近一次执行记录。
- **路由记录**：把节点开始、节点结束与路由判定按时间排成一条序列。点开始记录看当时的入参、进入方式与会话，点结束记录看提交的结果、状态与命令输出，点判定记录看用了哪个结果、走到哪个节点。同一时刻先结束、再判定、最后才开始下一个节点，读起来就是真实因果顺序。记录详情里可直接跳到该节点的执行记录。
- **子 Run / 并行轮次 / 恢复记录**：有内容时才出现，用列表项而不是表格。
- **节点执行**：左列是全部节点访问，右列是选中记录的详情。Agent 节点直接渲染 [pi-agent-trajectory-viewer](https://github.com/JhihJian/pi-agent-trajectory-viewer) 的轨迹工作区，可看消息、思考、工具调用、结果、搜索与时间线；命令节点展示标准输出与标准错误；执行Flow 节点给出子 Run 入口。运行中的节点每 5 秒重取一次轨迹，完成后停止轮询。

选中节点写在地址栏（例如 `#/runs/review-001?tab=nodes&node=nr-review-1`），刷新后停在同一条记录。页面只用一套 shadcn 组件（Card、Tabs、Table、Dialog、Item、Badge、Alert、Empty），区块标题在内容上方，内容自己带边框，避免卡片套卡片；窄屏下节点列表与详情改为上下排列。

轨迹来自 daemon 按节点执行保存的 Pi 会话 JSONL 切片（`~/.ursi-flow/runs/<runId>/trajectories/<节点执行 ID>.jsonl`），`server.mjs` 只做转发。旧运行或命令节点没有切片时页面说明原因，不影响其他证据。切片超过 8 MiB 时 daemon 只返回大小，页面提示不加载。

轨迹界面是上游项目的源码快照，放在 `src/trajectory/components` 与 `src/trajectory/lib`，不在本目录就地修改：

```sh
npm run sync:trajectory
```

脚本默认从 `/data/dev/pi-agent-trajectory-viewer` 复制，可用 `TRAJECTORY_VIEWER` 指向其他检出；它同时把参考样式里的 `body`、`:root`、滚动条与焦点选择器收进 `.trajectory-host`，并把来源提交写入 `src/trajectory/VENDOR.json`。表面、文字与描边由 `src/trajectory/theme-bridge.css` 映射到控制台主题，深色主题跟随 `data-theme`。

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

`npm test` 用临时目录里的假 daemon 覆盖协议映射、认证、错误码、请求上限和静态路径，并用纯函数测试覆盖运行事实到流转图的映射。`npm run test:e2e` 先构建 Runtime，再用真实 daemon 完成建包、校验、运行、停止、配置与冲突的闭环；`e2e/model-fixture.mjs` 提供本地 OpenAI 兼容模型，用来验收 Agent 节点的会话轨迹，测试还覆盖子目录静态演示、演示轨迹与窄屏布局。`dist/`、`node_modules/` 与端到端临时目录不在版本库中。

`flow-runtime` 的 npm 包只包含引擎（`dist/`、`docs/`、`examples/`），不含本目录。
