# ursi-flow

## 功能意图

ursi-flow 是基于 flow 的 agent 运行引擎。它把一次交付过程固化为固定结构的工作流程，按约定顺序驱动 agent 执行器完成单个过程，在关键节点由人工审批放行或打回，并把节点状态、工具轨迹、日志与产物集中呈现。

服务对象：需要把「可重复交付过程」固化为流程、并由 agent 执行器落地的团队与个人。提供的结果：可解析、可校验、可执行、可审批、可观测的工作流运行。

技术路线参考 grasp：Rust 后端 + SQLite 单机持久化 + 内嵌 Web 页面；沙箱控制面独立为 gateway 进程，经版本化 REST 契约与内核解耦；agent CLI 在隔离沙箱容器内运行，交付物落在沙箱内的 git 仓库工作区。

本引擎聚焦「流程运行」，首版明确不做：对话工作台、GitHub/PR 交付、多租户账号体系、AI 定时任务、统计与成本、并行分支调度、子流程（subflow）复用、拖拽式流程画布、Kubernetes/E2B 等远程沙箱驱动。这些能力仅在后续需要时扩展，不在当前模块边界内。

## 模块地图

执行链路：server（kernel）→ sandbox-gateway（沙箱控制面）→ Isolated Sandbox（容器，镜像与 bundle 见 sandbox-runtime/，通道服务由 channel 连接）→ Agent CLI（沙箱内，agent-runtime 接口 + agent-cli-adapter 适配）→ Repository Workspace（沙箱内 git 工作区，由 server/sandbox 管理输入注入与产物回收）。

| 模块 | 职责 |
|---|---|
| server | kernel：HTTP/WS/SSE 接入、应用服务、工作流引擎、存储、沙箱编排 |
| domain | 唯一共享契约层：流程定义、状态机、事件契约 |
| agent-runtime | agent 可控接口：Runner 契约、能力配置渲染约定、事件回流，实现见 agent-cli-adapter |
| agent-cli-adapter | 具体 agent CLI 适配（含 mock），实现 agent-runtime 接口 |
| channel | 通道控制：SSH/SFTP/ACP 传输/终端/code-server/CDP/noVNC/预览端口 |
| sandbox-gateway | 沙箱控制面：REST 生命周期、驱动抽象（fake/docker）、状态存储与恢复、端点暴露 |
| sandbox-runtime | 沙箱镜像环境定义 + runtime bundle（注入沙箱的服务与配置） |
| sandbox-observe | 观测面（预留）：agent 会话记录、主机侧命令记录、流量监测 |
| mcp-server | MCP 工具面：运维域、控制域、内部工具域 |
| web | Vue3 展示与审批页面 |
| server bin | ursi-flow 组装入口；sandbox-gateway 为独立二进制 ursi-gateway |

server 是依赖汇点：channel、agent-runtime、agent-cli-adapter、mcp-server 依赖 server 暴露的服务接口而不被 server 反向依赖（mcp-server 为 server 提供域实现，server 提供传输接入）。channel 与 agent-runtime 的切分线：channel 管连接与帧传输（字节层），agent-runtime 管 ACP 会话语义与控制接口（协议层）。

kernel（server）与 sandbox-gateway 是两个独立进程、独立编译单元，通过两份版本化契约耦合（见 sandbox-gateway/CONTRACT.md）：控制面（沙箱生命周期 REST）与运行面（kernel 经 gateway 暴露的端点直连沙箱执行命令与采集输出）。同机部署只是部署形态，不改变接口形态。

## 关键功能与验收

### 工作流定义与解析

固定结构的工作流程由节点与边构成的有向无环图（DAG）描述。节点类型为 agent、script、approval；边描述执行依赖。定义、解析与校验由 domain 承担。

#### 验收

- 给定一份合法的流程定义 JSON，解析后得到节点集合与边集合，并通过 DAG 校验。
- 给定含环的流程定义，解析校验返回错误且不产生运行。

### 单次运行执行

一次运行从流程定义冻结快照，按拓扑顺序执行节点，将输入与配置交给执行器，并管理执行环境生命周期。详见 server（engine、sandbox）、agent-runtime。

#### 验收

- 给定一条合法顺序流程与一个 mock 执行器，启动运行后节点按拓扑顺序逐个执行，运行终态为 succeeded。
- 运行创建后修改流程定义，不影响该运行的执行行为（快照冻结）。

### 人工审批

在审批节点处暂停运行，等待人工放行，或打回到指定环节返工。

#### 验收

- 运行到达审批节点后进入等待审批状态，不再推进下游节点。
- 放行后继续执行下游；打回到指定环节后，该环节及其下游被重置并重新执行。

### 能力定制

单次运行过程中，角色提示词、模型、Skills、MCP 工具按节点引用的角色定制，并传递给执行器。详见 domain、agent-runtime。

#### 验收

- 给定引用特定角色的 agent 节点，执行时该角色的提示词、模型、Skills、MCP 工具被渲染给执行器。

### 过程可观测

节点状态、工具轨迹、日志和产物在运行过程中统一采集，并通过 API 与页面呈现。详见 server（engine、handlers）、web。

#### 验收

- 运行过程中产生的节点状态变化与执行器工具轨迹可被订阅查询。事件由 server（engine）广播、server（database）持久化。
- 运行详情页能展示节点状态、工具轨迹、日志与产物。

### 持久化与恢复

工作流定义、运行与节点状态、观测事件持久化存储；引擎重启后可恢复未完成运行。详见 server（database、engine）。

#### 验收

- 引擎进程重启后，运行中流程的节点状态与观测事件可从持久化层读回。
- 租约到期的运行可被重新接管继续执行。
