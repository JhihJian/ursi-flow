# Web 工作台设计

工作台提供 Flow 包维护、运行控制和运行配置三个真实服务入口。React Router 将业务页放在常驻的响应式应用壳内，桌面侧栏和移动抽屉使用同一份导航数据。主题、通知、确认框和输入控件复用共享层。对话位于单独的本地演示组。

## 请求与会话

共享客户端固定使用同源 `/api/v1`。用户在受保护页面手动输入令牌，令牌存储于 `sessionStorage`，每次请求发送 `Authorization: Bearer <token>`。退出或收到当前令牌对应的 401 会回到登录表单，保留原页面地址。会话列表、资源和服务配置按需读取；React 文本节点负责展示服务返回的文本和 JSON。

## Runtime 契约

以下路径均相对于 `/api/v1`，成功响应直接使用 runtime JSON。

| 方法与路径 | 请求体 | 结果 |
| --- | --- | --- |
| `GET /flows` | 无 | Flow ID 字符串数组 |
| `POST /flows`、`POST /flows/validate` | `{id, files}` | `{id, revision}` 或 `{id, valid}` |
| `GET /flows/{id}` | 无 | `{id, revision, files}` |
| `PUT /flows/{id}` | `{files, expectedRevision}` | `{id, revision}` |
| `DELETE /flows/{id}` | 无 | 删除结果 |
| `POST /flows/{id}/runs` | `{runId?, workspace: "default", variables}` | job |
| `GET /runs`、`GET /runs/{id}` | 无 | job 数组或单个 job |
| `GET /runs/{id}/history` | 无 | job 及执行事实集合 |
| `POST /runs/{id}/stop` | 无 | 停止请求处理后的 job |
| `GET /flow-config`、`PATCH /flow-config` | PATCH 仅传改动字段 | `{executor, model, maxConcurrent}` |

包编辑器以相对路径为键维护文件正文，发布整包时携带读取到的 revision。验证不改变发布状态。启动成功后使用返回的 job ID 进入详情。运行中定期重读 job 与历史，终态或读取失败后停止自动刷新。网络错误留在当前页面，由操作者重试。

## 本地对话边界

`modules/chat/demo` 提供浏览器内的会话存储和 NDJSON 流。会话按浏览器持久化，助手回复来自固定示例。对话代码按路由加载，与 runtime HTTP 客户端各自选择数据源。
