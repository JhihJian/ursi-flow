# Flow 工作台

在浏览器里浏览、启动并跟踪 `FLOW.md` 包。服务端直接用 `apps/ursi-flow` 的推进内核执行流程，前端既可以独立打开，也可以作为 `flow` 模块接入工作区外壳。

## 结构

| 目录 | 职责 |
| --- | --- |
| `server/` | 零依赖 Node 服务：扫描 flow home、解析 Flow、启动运行、转发人工确认、读取运行日志，并托管 `web/dist`。 |
| `web/` | React 页面与工作区模块接入代码（`src/module.tsx` 导出 `createFlowModule`）。 |

数据归属：

- Flow 包留在用户指定的 flow home，默认 `file://<home>/.ursi/flow`，工作台只读不写。
- 设置与运行日志写在工作台状态目录，默认 `~/.ursi/flow-web`：`settings.json` 记录 flow home，`runs/<runId>/` 是运行头、快照与事件流。

## flow home 与路径

flow home 是[位置契约](../../packages/location/SPEC.md)里的位置 URI，设置文件与所有 API 里都是 `file:///abs/path` 形态。输入时三种写法都收：`file:///abs`、裸绝对路径 `/abs`、本机简写 `~`、`~/x`，保存时统一成规范 URI。只接受本机，`ssh://` 与相对路径被拒绝（400），原配置保留。

不接远程是有意的：Flow 引擎在本服务进程内执行，执行器契约的 `cwd` 是单个字符串，没有「在哪台机器跑」的维度，远端目录读回来也会在本机执行。等执行器契约有了设备维度再设计。

Flow 包自己的路径（`dir`、`path`、`flowPath`、`cwd`）仍是裸绝对路径，它们是给引擎与文件系统用的执行路径，不是跨模块身份。「在文件模块打开 Flow 目录」跨模块时转成位置 URI 再传。

## 运行

先构建推进内核，服务端从包入口取引擎与执行器：

```sh
cd apps/ursi-flow && npm install && npm run build
```

启动服务端与前端：

```sh
cd apps/flow-web/server && npm install && npm start   # 0.0.0.0:8094
cd apps/flow-web/web && npm install && npm run dev    # 0.0.0.0:5183，/api 代理到 8094
```

构建后可只跑服务端，它同时托管静态页面：

```sh
cd apps/flow-web/web && npm run build
cd ../server && npm start
# 打开 http://localhost:8094
```

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `FLOW_WEB_PORT` / `FLOW_WEB_HOST` | `8094` / `0.0.0.0` | 服务端监听地址 |
| `FLOW_WEB_HOME` | `~/.ursi/flow` | 首次启动时的 flow home（位置 URI 或本机路径简写）；之后以设置文件为准 |
| `FLOW_WEB_STATE` | `~/.ursi/flow-web` | 设置与运行日志根目录 |
| `FLOW_WEB_RUNS` | `<状态目录>/runs` | 单独指定运行日志根目录 |
| `FLOW_WEB_STATIC_DIR` | `web/dist` | 静态产物目录 |
| `FLOW_WEB_API` | `http://127.0.0.1:8094` | 前端开发服务器代理目标 |

## 同源 API

| 方法与路径 | 作用 |
| --- | --- |
| `GET /api/config` | 读取 flow home（位置 URI）、状态目录、运行根目录与当前执行器 |
| `PUT /api/config` | 保存 flow home：接受 `file://` URI、绝对路径或 `~` 简写，存成规范 URI；目录不存在时创建；`ssh://` 与相对路径返回 400 |
| `GET /api/flows` | 扫描 flow home，返回每个包的摘要（`dir` 是裸路径） |
| `GET /api/flows/:id` | 单个包的起始节点、变量、节点、结果边与并行结构 |
| `GET /api/runs` | 运行清单，按开始时间倒序；每条带执行器标识、步数与最近一次快照的变量 |
| `POST /api/runs` | 用启动变量开始一次运行，返回 `runId` |
| `GET /api/runs/:runId` | 运行状态、待决确认、过程事件与变量 |
| `POST /api/runs/:runId/confirm` | 提交人工确认结果 |
| `POST /api/runs/:runId/resume` | 从快照继续未完成的运行 |
| `POST /api/runs/:runId/stop` | 把未结束的运行标记为停止 |

启动变量与 Flow 定义在开跑前校验；非法输入同步返回 400，不留下半截运行。正在执行的运行不能停止，避免与推进竞争。

## 工作区布局

工作区分三列固定区域，切换 Flow 时位置与尺寸不变：

- 左：启动变量与执行器，整列固定宽度 200–240px，内容超长在列内滚动，运行按钮贴底。
- 中：结构图，占剩余宽度与整列高度；小图按原始尺寸居中，大图等比缩到容器内，不出现滚动条。
- 右：运行记录固定占 38% 高度，下面是运行详情；没选中运行时常驻一句提示，避免选中后布局跳动。

容器窄于 900px 时退回单列，结构图限高 420px。

## 结构图

工作区的结构区默认画成从上到下的分层图，不依赖图形库：

- 布局是纯函数（`web/src/lib/graph.ts`）：先深度优先找环，回边不参与分层，避免「返工」边把层级越推越深；再按最长路径分层、同层水平居中。
- 走线分三类，互不抢道：相邻层正向边走层间走廊，每条边一条水平车道；跨节点回边走左侧留白，跨层正向边走右侧留白，每条边一条竖车道；自环画在节点右侧。
- 同一节点上的多条出边或入边在节点边上错开成不同端口，短横段与短竖段因此不会落在同一条线上。
- 侧边车道与节点外框至少留 14px，连线不会贴着或压住节点边框。
- 标签统一放在留白最外侧的一列，压在自己那条边的出口横段上方；留白按车道数与最宽标签计算，文字既不互相遮挡，也不盖住任何连线。
- 渲染是自绘 SVG（`components/FlowGraph.tsx`），灰阶沿用页面变量，回边用虚线；图区在固定高度内滚动，滚动条隐藏，靠边框和内边距分隔。
- 点节点时结构图让出高度，在下方展开该节点的完整提示词或命令；详情高度最多占中列的 62%，不越过列底，也不会把页面撑出滚动；提示更长时在详情内部滚动。同时高亮该节点的所有出边、其余连线降到中灰（不是整体变透明，仍可读）；再点一次取消。只有还在推进或等待确认的运行才把最后进入的节点标为「当前」，已完成、失败、已停止的运行不标。
- 结构区可以切回逐条列表看提示与命令。

## 执行器

执行器是可选清单，不是单一实现。清单来自 `apps/ursi-flow` 的 `builtinExecutors`：每项有 `id`、标题、说明和 `create()`。服务端为每个执行器各建一份引擎实例，共用同一个存储；界面在启动区把它们列成下拉。

- 运行头记录执行器 `id`。看历史运行时知道当时用的是谁；恢复（`resume`）要求执行器标识一致，换过清单会提示「未接入的执行器」，不会把旧运行接到新实现上。
- 未登记的 `id` 在启动时直接拒绝，错误里列出可用清单。
- 现在清单里只有 `fake`：Agent 节点取第一条结果边，命令节点返回退出码 0。它验证的是「选 Flow、填变量、跑完、作答、看日志」这条闭环。
- 首条边就是返工边的 Flow（`simplify`、`review-fix`）在假执行器下会一直循环，最后由调用上限拦下并记为失败；这属于预期行为。

新增执行器的步骤：

1. 在 `apps/ursi-flow/executor/adapters/` 新增实现，导出带 `id` 的 `FlowExecutor`。
2. 在 `apps/ursi-flow/executor/adapters/index.ts` 的 `builtinExecutors` 里登记一行（标题、说明、`create`）。
3. 重新构建 `apps/ursi-flow`，重启本服务。界面下拉与 API 自动多出一项，无需改前端或服务端路由。

## 测试

```sh
npm test -w @ursi/flow-web-server   # flow home 规范化与拒绝、扫描、解析、运行、确认、停止
npm test -w @ursi/flow-web          # 变量表单、状态文案、选中发布、操作可用性、flow home 编辑区与选目录器
```

## 接入工作区外壳

`src/module.tsx` 导出 `createFlowModule({ apiBaseUrl, openRootInFiles, host })`：

- `openRootInFiles(root)` 接位置 URI。flow 把 Flow 包目录从裸路径转成 `file://` URI 再传，自己不 import 文件模块。
- `host.listDir` 是 flow home 选目录器的数据源，组合根接文件模块的 `commands.browse`。不注入设备清单：flow home 必须在本机，选目录器只有本机一项。未注入时侧边栏不显示「浏览目录…」。

工作区外壳注册模块、注入 API 前缀与这两项能力，开发代理把 `/api/flow-web` 转发到本服务并把前缀重写回 `/api`。模块样式随 `@ursi/flow-web/styles.css` 引入，全部挂在 `.flow-*` 根类下。
