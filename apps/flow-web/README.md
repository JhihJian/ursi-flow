# Flow 工作台

在浏览器里浏览、启动并跟踪 `FLOW.md` 包。服务端直接用 `apps/ursi-flow` 的推进内核执行流程，前端既可以独立打开，也可以作为 `flow` 模块接入工作区外壳。

## 结构

| 目录 | 职责 |
| --- | --- |
| `server/` | 零依赖 Node 服务：扫描 flow home、解析 Flow、启动运行、转发人工确认、读取运行日志，并托管 `web/dist`。 |
| `web/` | React 页面与工作区模块接入代码（`src/module.tsx` 导出 `createFlowModule`）。 |

数据归属：

- Flow 包留在用户指定的 flow home，默认 `~/.ursi/flow`，工作台只读不写。
- 设置与运行日志写在工作台状态目录，默认 `~/.ursi/flow-web`：`settings.json` 记录 flow home，`runs/<runId>/` 是运行头、快照与事件流。

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
| `FLOW_WEB_HOME` | `~/.ursi/flow` | 首次启动时的 flow home；之后以设置文件为准 |
| `FLOW_WEB_STATE` | `~/.ursi/flow-web` | 设置与运行日志根目录 |
| `FLOW_WEB_RUNS` | `<状态目录>/runs` | 单独指定运行日志根目录 |
| `FLOW_WEB_STATIC_DIR` | `web/dist` | 静态产物目录 |
| `FLOW_WEB_API` | `http://127.0.0.1:8094` | 前端开发服务器代理目标 |

## 同源 API

| 方法与路径 | 作用 |
| --- | --- |
| `GET /api/config` | 读取 flow home、状态目录、运行根目录与当前执行器 |
| `PUT /api/config` | 保存 flow home（绝对路径，目录不存在时创建） |
| `GET /api/flows` | 扫描 flow home，返回每个包的摘要 |
| `GET /api/flows/:id` | 单个包的变量、节点、结果边与并行结构 |
| `GET /api/runs` | 运行清单，按开始时间倒序 |
| `POST /api/runs` | 用启动变量开始一次运行，返回 `runId` |
| `GET /api/runs/:runId` | 运行状态、待决确认、过程事件与变量 |
| `POST /api/runs/:runId/confirm` | 提交人工确认结果 |
| `POST /api/runs/:runId/resume` | 从快照继续未完成的运行 |
| `POST /api/runs/:runId/stop` | 把未结束的运行标记为停止 |

启动变量与 Flow 定义在开跑前校验；非法输入同步返回 400，不留下半截运行。正在执行的运行不能停止，避免与推进竞争。

## 执行器

当前接入的是 `FakeExecutor`：Agent 节点取第一条结果边，命令节点返回退出码 0。因此这份工作台现在验证的是「选 Flow、填变量、跑完、作答、看日志」这条闭环，而不是真实 Agent 的质量。换成真实执行器只需要替换服务端 `createRunService` 的 `executor`，界面与 API 不变。

注意默认执行器取第一条结果边：首条边就是返工边的 Flow（如 `simplify`、`review-fix`）会一直循环，最后由假执行器的调用上限拦下并记为失败。这属于预期行为，预设回执需要真实执行器或测试脚本。

## 测试

```sh
npm test -w @ursi/flow-web-server   # 配置、扫描、解析、运行、确认、停止
npm test -w @ursi/flow-web          # 变量表单、状态文案、选中映射、操作可用性
```

## 接入工作区外壳

`src/module.tsx` 导出 `createFlowModule({ apiBaseUrl, openRootInFiles })`。工作区外壳注册模块、注入 API 前缀与文件模块命令，开发代理把 `/api/flow-web` 转发到本服务并把前缀重写回 `/api`。模块样式随 `@ursi/flow-web/styles.css` 引入，全部挂在 `.flow-*` 根类下。
