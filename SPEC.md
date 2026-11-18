---
references:
  - ursi-sandbox/DESIGN.md
  - server/DESIGN.md
---

# ursi-flow

## 功能意图

ursi-flow 是基于 flow 的 agent 运行引擎。它把一次交付过程固化为固定结构的工作流程，按约定顺序驱动 agent 执行器完成单个过程，在关键节点由人工审批放行或打回，并把节点状态、工具轨迹、日志与产物集中呈现。

服务对象：需要把「可重复交付过程」固化为流程、并由 agent 执行器落地的团队与个人。提供的结果：可解析、可校验、可执行、可审批、可观测的工作流运行。

技术路线参考 grasp：Rust 后端 + SQLite 单机持久化 + 内嵌 Web 页面；沙箱控制面独立为 gateway 进程，经版本化 REST 契约与内核解耦；agent CLI 在隔离沙箱容器内运行，交付物落在沙箱内的 git 仓库工作区。

本引擎聚焦「流程运行」，首版明确不做：对话工作台、GitHub/PR 交付、多租户账号体系、AI 定时任务、统计与成本、并行分支调度、子流程（subflow）复用、拖拽式流程画布、Kubernetes/E2B 等远程沙箱驱动。这些能力仅在后续需要时扩展，不在当前模块边界内。

## 模块地图

Flow 负责编排与审批，[ursi-sandbox](ursi-sandbox/DESIGN.md) 负责执行环境。独立 CLI 和 Flow 都是该环境的调用方。Flow 的 `pi` 角色通过运行专属绑定连接已就绪的 Runtime，角色选择和业务重试留在引擎。

| 模块 | 职责 |
|---|---|
| [flow-runtime](flow-runtime/SPEC.md) | 可独立交付的 FLOW.md 运行时与本地 Pi 执行器。当前 Rust Server 仍使用下列 JSON 流程模块。 |
| [flow-core](flow-core/SPEC.md) | workflows、roles、runs、artifacts、sandboxes、connections 六个业务域，共享领域契约、存储与执行端口 |
| [sandbox-access](sandbox-access/SPEC.md) | Gateway v1 资源控制、Channel 传输与按运行绑定的 Runtime ACP 接入 |
| [server](server/SPEC.md) | `ursi-flow` 主服务：app 装配、HTTP/SSE、MCP 工具和静态资源入口 |
| ursi-sandbox | 独立 workspace：Gateway 管资源，Runtime 管执行，Client 提供公共调用库和 CLI |
| web | React 19 + TypeScript + Vite 前端，按 workflows、roles、runs、artifacts、sandboxes、connections、chat 七域组织，app/shared 提供装配、shadcn 基元与基础能力；Zustand 管理应用级状态 |

沙箱不链接 Flow 的领域类型。资源管理遵循 [Gateway v1 契约](contracts/gateway/v1/README.md)，当前文本执行的接入条件和验收范围见 [Flow 调用说明](server/REAL-RUNTIME-ACP.md)。

## 关键功能与验收

### 工作流定义与解析

固定结构的工作流程由节点与边构成的有向无环图（DAG）描述。节点类型为 agent、script、approval；边描述执行依赖。定义、解析与校验由 domain 承担。

#### 验收

- 给定一份合法的流程定义 JSON，解析后得到节点集合与边集合，并通过 DAG 校验。
- 给定含环的流程定义，解析校验返回错误且不产生运行。

### 单次运行执行

一次运行从流程与角色配置冻结快照，按拓扑顺序执行节点，将输入与配置交给执行器，并管理执行环境接入。详见 flow-core（runs、sandboxes、agent_runtime）。

#### 验收

- 给定一条合法顺序流程与一个 mock 执行器，启动运行后节点按拓扑顺序逐个执行，运行终态为 succeeded。
- 运行创建后修改流程定义，不影响该运行的执行行为（快照冻结）。

### 人工审批

在审批节点处暂停运行，等待人工放行，或打回到指定环节返工。

#### 验收

- 运行到达审批节点后进入等待审批状态，不再推进下游节点。
- 放行后继续执行下游；打回到指定环节后，该环节及其下游被重置并重新执行。

### 能力定制

角色可创建、编辑、复制和查询，拥有系统提示词、模型选择、Skills 文件与 MCP 配置。流程节点引用角色，创建运行时冻结有效配置。详见 flow-core（roles、connections、runs、domain、agent_runtime）。

#### 验收

- 给定引用特定角色的 agent 节点，执行时该角色的提示词、模型、Skills、MCP 工具被渲染给执行器。
- 编辑角色后，已创建运行保持原配置，新运行使用更新配置。

### 过程可观测

节点状态、工具轨迹、日志和产物在运行过程中统一采集，并通过 API 与页面呈现。详见 flow-core（runs、artifacts）、server 的 transport 和 web。

#### 验收

- 运行过程中产生的节点状态变化与执行器工具轨迹可被订阅查询。runs 先原子提交状态与事件，再广播，transport 从持久事件重放与补读。
- 运行详情页能展示节点状态、工具轨迹、日志与产物。

### 持久化与恢复

工作流定义、角色配置、运行与节点状态、观测事件持久化存储；引擎重启后可恢复未完成运行。详见 flow-core 各域存储接口以及 storage、runs。

#### 验收

- 引擎进程重启后，运行中流程的节点状态与观测事件可从持久化层读回。
- 租约到期的运行可被重新接管继续执行。
