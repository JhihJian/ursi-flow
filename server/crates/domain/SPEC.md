---
parent: ../../SPEC.md
---

# domain

## 功能意图

domain 是 ursi-flow 唯一的共享领域模型与契约层。它拥有跨模块复用的类型定义、工作流结构定义与解析校验、运行状态机枚举、角色与能力定制模型、执行环境句柄契约、执行器与产物契约，以及观测事件契约。其他模块引用 domain 的类型，不得各自重新定义等价结构。

## 关键功能与验收

### 工作流结构定义与解析

用 Rust 结构体（struct）表达固定结构的工作流程：`WorkflowDefinition` 含节点集合与边集合；`WorkflowNode` 按 `Type` 区分 agent、script、approval 三类；`WorkflowEdge` 由 `Source` 指向 `Target` 描述执行依赖。

解析（`ParseWorkflow`）负责把 JSON 解码为结构体；校验（`ValidateWorkflow`）负责节点字段语义与 DAG 无环检查。

#### 验收

- 给定一段含节点与边的流程 JSON，`ParseWorkflow` 返回结构体，`ValidateWorkflow` 无错误。
- 给定缺失节点 ID 或重复节点 ID 的定义，`ValidateWorkflow` 返回错误。
- 给定引用不存在节点的边，`ValidateWorkflow` 返回错误。
- 给定构成环的边集合，`ValidateWorkflow` 返回错误（DAG 校验）。
- 给定 `Type` 为 script 且 `Script` 为空的节点，`ValidateWorkflow` 返回错误。
- 给定未知的节点 `Type`，`ValidateWorkflow` 返回错误。

### 运行状态机

定义运行与节点的状态全集及其合法流转，供 engine、repo、api 共同引用。

运行状态：`queued`、`running`、`waiting`、`succeeded`、`failed`、`cancelled`。节点状态：`pending`、`running`、`waiting_approval`、`succeeded`、`failed`、`cancelled`、`skipped`。

#### 验收

- domain 提供运行状态与节点状态的枚举常量，engine 与 repo 引用同一组常量，不存在魔法字符串。
- 提供状态合法性判断函数：给定非法状态字符串返回 false。

### 角色与能力定制

`Role` 定义单次过程中可定制的角色能力：提示词（Prompt）、模型（Model）、Skills 与 MCP 配置。agent 节点通过 `RoleID` 引用角色，产出物声明和审批规则属于工作流节点。domain 提供纯数据契约及字段校验，server 的 workflows 与 roles 模块负责引用存在性和持久化约束。

#### 验收

- 给定一个含 Prompt、Model、Skills、MCPServers 的角色定义，可解析为 `Role` 结构体并保留全部字段。
- agent 节点缺少 `RoleID` 或其值为空时，纯工作流校验返回错误；角色是否存在由 server 工作流保存和运行创建用例校验。

### 执行器定义

`Executor` 描述一种执行器的标识与类型（mock 或具体 agent CLI）。执行输入与结果接口由 agent-runtime 提供，CLI 适配器在沙箱内使用。`ExecutionEnv` 是命令与文件操作的可替换契约，不决定操作发生在何处，也不拥有沙箱生命周期。服务端连接由 Channel 提供，沙箱内适配器使用本地执行环境。资源管理归 Gateway lifecycle，会话归 session-service。

#### 验收

- `Runner` 接口声明输入（提示词、配置、上下文、环境句柄）与结果（输出、产物、用量、错误）的完整契约，接口定义可编译。
- `ExecutionEnv` 的实现可替换（本地目录与沙箱容器实现同一接口），Runner 实现不感知差异。
- `Executor` 的 `Kind` 枚举包含 mock 与至少一种真实 agent CLI。

### 产物契约

`Artifact` 描述一次运行中节点产生的交付物：名称、路径、是否必需、内容类型。节点的产出物声明用于输入交接与输出校验。

#### 验收

- 给定一个声明了产物名称与路径的节点，解析后保留该契约。
- 声明必需产物但执行后缺失时，校验函数返回错误。

### 观测事件契约

`TelemetryEvent` 描述运行过程中产生的观测事件：类别、名称、阶段、消息、属性。工具轨迹、日志与产物发布均映射为该契约，供 engine 产生、observe 采集、repo 存储、api 与 web 呈现。

#### 验收

- `TelemetryEvent` 结构体包含类别、名称、阶段、消息、属性字段，且类别与阶段的取值有枚举约束。
