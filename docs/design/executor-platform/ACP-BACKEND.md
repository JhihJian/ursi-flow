# 平台执行后端统一为 ACP

执行器平台以 ACP v2 Preview beta.3 经本机 stdio 连接受管 Agent。Pi 是内置实现，复用 Pi SDK 的会话执行、工具授权与结果校验。所有平台新尝试使用同一条 ACP 路径，试跑和固定修订执行均不回退到 MCP。

## 调用边界

| 连接 | 协议与职责 |
| --- | --- |
| Workbench、Flow Runtime → 执行器平台 | HTTP 提交、查询、取消和只读制品。`attemptId` 作为调用方可查回的执行身份。 |
| 执行器平台 → 受管 Agent | ACP v2 stdio；每次尝试由独立 worker 持有连接，在新 `sessionId` 中提交一个任务。 |
| Pi → 业务工具 | 按部署策略调用经授权的只读 MCP 工具。工具协议与尝试执行协议分开。 |

Pi 的平台部署入口是 `ursi-pi-executor-acp`，旧 `ursi-pi-executor-mcp` 已从包和源码移除。独立的 [`ursi-flow-executor-mcp`](../../../flow-runtime/README.md#mcp-执行器-adapter) 和执行器 SDK 为 MCP 客户端提供整条 Flow 的启停与查询。这个适配器位于平台执行链路之外，操作的是 Runtime 中的固定修订 Run，待独立使用方审计后决定去留。

## 配置与执行

执行器发布固定系统提示词、Skills 及配套文件、模型引用、获授权的业务工具列表以及 ACP 后端绑定。受管 Agent 除了协商 ACP v2，还须支持项目约定的配置装配、单任务执行、停止确认与文件交付。管理员用临时会话预检，正式尝试按所选修订装配配置，细节见[执行契约](ACP-PROFILE.md)与[部署说明](../../../executor-platform/server/src/work/agent_backends/README.md)。

1. 平台持久登记归属、目标、输入与配置摘要，准备私有工作区，启动该次 worker。worker 负责 ACP 连接和账本，独立于 HTTP 请求；HTTP 服务重启后仍存活的 worker 可继续执行。
2. worker 装配会话，持久记录 `sessionId` 与提交意图，再发送唯一一次 `session/prompt`。prompt 回执确认消息插入，可先于或晚于实时更新。重复 PUT、查询和服务重启均不重发任务。
3. worker 记录本轮终态证据，限时关闭会话并确认受管进程组停止。HTTP 服务查到可信结果后收集并发布制品；收集未完成时可按原 ID 继续。取消先登记意图再通知原会话；证据不足则保持 `unverified`。

## 事件与终态

worker 将根会话的回复、工具和状态更新写成有界、按序持久化的事件。平台为原角色提供带游标的归一化事件页；它保留消息片段和工具更新，不拼接成会话视图，也不透传 ACP 帧。事件与制品分开读取。采集缺口只描述轨迹完整性，终态以尝试账本和制品发布为准。

## 从旧平台执行链路切换

1. 停接旧执行请求，排空在途尝试并确认制品已发布，停服后备份原平台数据目录。
2. 部署 ACP 程序和策略，在平台重新检查后端。用原配置包发布新的 ACP 修订，让 Workbench 和 Runtime 选择新修订。旧 MCP 修订和绑定保留为历史，不覆写或补造旧快照；在途旧尝试不会自动接续到 ACP。
3. 使用原角色、原 `attemptId` 验证切换前已发布的结果与制品仍可读取。用新修订验证工作包直跑、Flow 节点分支、取消和归一化事件续读。按[平台验收](../../../executor-platform/acceptance/README.md)检查两条消费路径，再移除旧 Pi MCP 启动配置。

[协议基线与首版范围](ACP-SCOPE.md)说明 Pi 的互操作基线、可选能力及异机接入条件。
