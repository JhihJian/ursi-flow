---
parent: ../../SPEC.md
depends-on:
  - ../domain/SPEC.md
  - ../channel/SPEC.md
  - ../../../ursi-sandbox/client/SPEC.md
references:
  - ../../../ursi-sandbox/runtime/AGENT-CONTRACT.md
  - ../../REAL-RUNTIME-ACP.md
---

# Agent Runtime

## 功能意图

定义 agent 可控接口和会话语义，向 server 提供创建会话、执行、取消、关闭及事件回流能力。真实执行直接使用沙箱 client 的 ACP WebSocket，Pi 适配归 Runtime。Flow 的内部长度帧接口保持独立。共享输入、结果和事件契约可供客户端与适配器实现使用。

## 关键功能与验收

### 会话控制

关联运行、节点、会话与执行请求，提交 prompt 和角色能力配置，返回统一结果和终态。工作流重试策略由 server engine 决定。生产接入使用 `ursi-sandbox-client` 的公开 `Acp` API，经真实 WebSocket 连接 Runtime `/acp`；旧的 `AcpFrameTransport` 仅保留给既有替身与兼容的内部测试路径。

Flow 当前接入 Runtime ACP 子集：`initialize`、`session/new`（固定 `/ursi/workspace/repo`、空 `mcpServers`）、`session/prompt`、`session/update`、`session/cancel`、`_ursi/session/status` 和 `_ursi/session/close`。Flow skills 与非空 MCP 列表无法由该子集表达，真实 Runner 明确拒绝；模型由 Runtime 管理员 profile 固定，模型字段只接受未指定或 `runtime-profile`。角色提示词、节点任务与上游上下文按顺序组成文本，不作为 `session/new` 的扩展字段。

#### 验收

- 一次执行的请求、事件和结果保持同一关联标识。
- 取消或关闭请求能到达对应会话，并返回可判断的执行状态。
- 连接中断可与任务失败区分，不自动重复提交未知结果的任务。单次执行接口无法确认执行已结束时，返回结果未知，不报告已停止。
- 真实 WebSocket 对端验证 RPC 请求、通知、事件、终态和显式关闭；未配置真实服务时不宣称已完成真实链路。

### 能力配置契约

约定提示词、模型、Skills 和 MCP 服务等配置输入。CLI 特有的参数和文件渲染由 Adapter 在沙箱内执行。

#### 验收

- 内部帧契约保持配置往返完整。真实 WebSocket 路径只接受 Runtime 支持的配置，其他能力明确报错。
- 变更具体 CLI 不要求 server 拼接 CLI 命令或写入特定格式配置。

### 事件回流

将 session-service 返回的状态、输出与工具事件映射为统一事件，供 server 展示和观测采集。当前已接入层级为 Runtime ACP 协议与 Flow Runner，尚未接入 Gateway 沙箱准备、SSH/SFTP 工作区准备、产物回收或真实模型联合验收。

#### 验收

- 执行期间持续收到属于当前会话的事件，终态与最终结果一致。
- 观测消费者缺失不会阻止控制请求和结果返回。
