---
parent: ../SPEC.md
depends-on:
  - ../flow-runtime/client/SPEC.md
references:
  - DESIGN.md
  - DESIGN-v2.md
  - README.md
---

# ursi-server

## 功能意图

Server 通过 `/api/v2` 管理工作包、资源和执行器，按包版本发起工作项，跟踪每次执行、交付和验收。`/api/v1` 提供可选的 Flow 管理入口：Server 管理本机 `ursi-flowd` 子进程，Flow Runtime 持有 Flow 包修订、运行配置和节点历史。扩展目标与当前边界见 [Server v2 设计](DESIGN-v2.md)。

| 模块 | 职责 |
| --- | --- |
| [app](src/app/SPEC.md) | 读取部署配置、启动和回收 daemon、装配 HTTP 服务。 |
| [flow](src/flow/SPEC.md) | 解析工作区别名，用有界的阻塞任务调用 `FlowClient`。 |
| [transport](src/transport/SPEC.md) | 两版 API 的统一 Bearer 鉴权、路由组合和 v1 错误映射。 |
| [定义目录](src/work/catalog/SPEC.md) | 按版本发布、查询和停用资源、执行器与工作包。 |
| [工作项](src/work/items/SPEC.md) | 保存派工快照、办理状态、各版交付文本与验收记录。 |
| [执行尝试](src/work/execute/SPEC.md) | 运行受信本地 Pi、固定修订的 Flow 或绑定预配沙箱的 ACP Agent。 |
| [文件来源](src/work/sources/SPEC.md) | 从管理员提供的 JSON 导出读取材料，按预设动作派工。 |

## 关键功能与验收

### 从工作定义到验收

#### 验收

- 工作项保存指定包版本的执行器和资源快照。相同请求标识及派工参数返回原单。配置 `json-file` 来源时按当前导出材料及预设包版本派工，不自动执行。
- 仅办理中的工作项可执行动作。Flow 尝试以尝试 ID 和固定修订启动；目录修订不匹配时返回 409，记录失败尝试，不运行节点。Agent 的一次回复不会自动交付或通过验收。
- 收存交付文本后才进入待验收状态。退回后可提交新版，旧版文件和意见仍可读。文件接口仅针对本单交付版本，没有 PTY、浏览器或通用文件管理。
- 预配沙箱与单一工作项绑定，不可用时不回退本地。自动测试仅以模拟 CLI 验证 ACP 契约；本地 Agent 的 HTTP 验收使用真实 Pi CLI 和模拟模型，详见[验收说明](tests/WORK-ACCEPTANCE.md)。

### HTTP 管理入口

#### 验收

- 启用 Flow 时，`/api/v1` 提供包校验与增删查改、启动与停止运行、运行详情与历史、运行配置读写。CLI 连接同一 socket 时能读回 HTTP 提交的更改。
- 未经认证的 API 请求返回 401。v1 运行请求只接受 `default` 工作区，目录由部署者配置。
- Server 不提供页面或静态资源。非 API 路径返回 404。

### 子进程与持久数据

#### 验收

- 缺少 `URSI_API_TOKEN` 时启动失败。默认启动配置的 daemon 并等待就绪；已有 socket 时拒绝启动。`URSI_FLOW_ENABLED=0` 时不启动 daemon、不挂载 v1，内置工作清单仍可用。
- 收到 `SIGTERM` 或 `SIGINT` 后，HTTP 监听和本实例启动的 daemon 均退出。以同一数据目录重启，可从私有 `work/` 查回工作定义、工作项与交付记录，启用 Flow 时还能从独立的 `flow-runtime/` 查回 Flow 包和运行历史。
