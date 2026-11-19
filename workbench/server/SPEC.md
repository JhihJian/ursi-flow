---
parent: ../SPEC.md
depends-on:
  - ../../flow-runtime/client/SPEC.md
references:
  - DESIGN.md
  - DESIGN-v2.md
  - README.md
---

# ursi-server

## 功能意图

Server 通过 `/api/v2` 管理工作包、资源和执行器，按包版本发起工作项，跟踪每次执行、交付和验收。`/api/v1` 提供可选的 Flow 管理入口：Server 管理本机 `ursi-flowd` 子进程，Flow Runtime 持有 Flow 包修订、运行配置和节点历史。扩展目标与当前边界见 [Server v2 设计](DESIGN-v2.md)。

### 领域与实体归属

| 领域 | 核心实体 | 归属模块 | 实体关系与职责 |
| --- | --- | --- | --- |
| 资源定义 | 资源、资源版本 | [catalog](src/work/catalog/SPEC.md) | Skill、提示词和 MCP 配置引用是资源类型。工作包和执行器按版本引用资源。 |
| 执行器定义 | 执行器、执行器版本 | [catalog](src/work/catalog/SPEC.md) | Agent 和 Agent Flow 是执行器类型。多个工作包可共用一个执行器版本。 |
| 派工模板定义 | 模板、模板版本（协议 `packages`） | [catalog](src/work/catalog/SPEC.md) | SOP、验收标准和具名动作随包版本发布。每个动作绑定一个执行器版本。 |
| 工作项办理与验收 | 工作项、交付版本 | [items](src/work/items/SPEC.md) | 一张单保存当次输入和包版本快照，可多次交付。文件和验收意见归属具体交付版本。 |
| 执行跟踪 | 执行尝试 | [execute](src/work/execute/SPEC.md) | 每次尝试属于一张单的一个动作。模块记录执行结果，按运行 ID 或会话 ID 查询后端证据。 |
| 虚拟目录资源 | 目录标识、文件树和正文 | [directories](src/work/directories/SPEC.md) | 凭目录 ID 独立操作私有根中的文件。 |
| 工作包与配置包 | 元信息和目录引用 | [patches](src/work/patches/SPEC.md) | 两张包表各持有目录资源 ID。配置包创建时建立提示词、Skills 和 MCP 的约定文件。 |
| Echo 工作区与 SOP | 工作包类型、SOP 修订、材料、Echo 回执 | [工作包与 SOP](src/work/workspace_sop/SPEC.md) | 每包有独立材料目录。SOP 单独发布，执行尝试固定所用的修订。Echo 产物不代表业务验收。 |
| 外部来源接入 | 来源、来源条目 | [sources](src/work/sources/SPEC.md) | 按来源条目和固定动作派工。来源提供材料，工作项保留派工时的输入。 |
| Flow 运行后端 | Flow 包、Flow 运行、节点运行 | [Flow Runtime](../../flow-runtime/SPEC.md) | Runtime 持有目录修订、运行状态和节点历史。[flow](src/flow/SPEC.md) 提供 v1 用例，`execute` 按运行 ID 跟踪 v2 尝试。 |

[app](src/app/SPEC.md) 负责服务装配及 daemon 启停，[transport](src/transport/SPEC.md) 负责两版 API 的路由、Bearer 鉴权和 v1 错误映射。

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
