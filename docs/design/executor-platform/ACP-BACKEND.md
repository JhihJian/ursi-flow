# 执行器协议统一为 ACP

## 决策

**平台到执行器统一使用 ACP，切换后移除 MCP 执行入口。** 平台直接作为 ACP 客户端，由受管的执行进程持有连接。Pi 提供 ACP 服务，复用现有 SDK 执行、工具授权和结果校验逻辑。平台与执行器之间不设 MCP 桥，也不保留按请求回退路径。

Workbench 和 Flow Runtime 仍通过现有 HTTP API 提交任务、查询和取消。`attemptId` 是平台的业务执行身份，`sessionId` 是 ACP 会话身份。冻结配置、执行记录和制品交付是平台职责。业务 MCP 工具和资源，以及 Runtime 本地 Flow 编排，保持各自原有边界。

首版固定一个受管 Pi 后端和本机 stdio 传输，使用通过互操作验收的 ACP v2 版本。Agent 的接入条件包括可验证的配置装配、单任务执行、停止确认和文件交付。支持 ACP 并不自动满足这些条件。首版本机部署通过受管启动配置、私有工作区和尝试账本提供这些保证，无需自定义 ACP 方法。实际调用和事件处理见 [ACP 执行契约](ACP-PROFILE.md)。

## 替换范围

| 范围 | 切换动作 |
| --- | --- |
| 平台执行与后端管理 | [调用入口](../../../executor-platform/server/src/work/executor/client.rs#L80) 和[后端探测](../../../executor-platform/server/src/work/agent_backends/http.rs#L75) 从 MCP 工具检查改为 ACP 初始化与能力检查。发布绑定固定部署者登记的程序版本和策略。试跑、启动、查询和取消全部收敛到同一条执行路径。 |
| Pi 执行器 | 替换 `ursi-pi-executor-mcp` 可执行入口，复用 [Pi 会话执行逻辑](../../../flow-runtime/src/pi-executor/session.ts#L49)。将文本、工具与生命周期更新发到 ACP，并保留普通工作包与 Flow 节点的结果校验。 |
| 整条 Flow 执行器 | 旧 [`ursi-flow-executor-mcp`](../../../flow-runtime/src/integrations/mcp/executor.ts#L248) 启停的是一个固定修订的 Runtime Run，与平台委派一个 Agent 节点不同。[当前平台公开 API](../../../executor-platform/server/src/work/access.rs#L268) 要求显式选择执行器，不接受旧的无目标 Flow 启动。清点独立使用方后退役旧 MCP 入口，正常 Flow 启动留在 Runtime。如果有使用方需要保留整条 Flow 作为执行器，应在切换前提供显式的 ACP 目标，复用 Runtime 内部启停和查询，并禁止将其用作 Agent 节点后端。 |

## 配置和任务怎样交付

执行器修订冻结系统提示词、启用的 Skills 及配套文件、模型引用和获授权的 MCP 工具列表。系统提示词由 ACP 设置，其余配置由受管 Pi 在本机装配。具体配置来源及生效条件见[执行契约](ACP-PROFILE.md#agent-配置与生效条件)。

当前[发布逻辑](../../../executor-platform/server/src/work/catalog/agent.rs#L115)只保存 `SKILL.md` 正文，[Pi 加载器](../../../flow-runtime/src/pi-executor/resources.ts#L4)将其拼入系统提示。切换时补齐文件快照和按冻结列表加载的能力。业务材料另以只读快照交付，任务文本单独发给 `session/prompt`。

## 一次尝试怎样执行

1. 平台持久登记 `attemptId`、调用方归属、执行器修订及输入和配置摘要。同 ID 同请求查回原尝试，变更请求返回 `409`。受监督的执行进程独立于 HTTP 服务进程，持有 ACP stdio 连接和尝试账本。
2. 装配和能力检查通过后建立新会话。把 `sessionId` 和提交意图持久化，再发送唯一一次 `session/prompt`。双向消息循环同时处理回执、`session/update` 和反向请求。v2 的 `messageId` 只确认消息已插入。回执可先于或晚于更新。同一连接的会话更新仍按发送顺序处理。
3. 实时收集本轮结束信号。受管后端必须报告可关联的结束原因。收到本轮实时 `idle/end_turn` 后调用 `session/close`，确认写入方停止，再校验制品并提交终态和不可变快照。初始或恢复时的 `idle` 不算本轮结束。发布中断只继续发布，不重新运行。Flow 节点还须恰有一次合法的 `submit_flow_outcome`，由 Runtime 复验 `flow-outcome.json` 后选边。
4. 查询读原尝试账本。HTTP 服务重启后，存活的执行进程继续采集。取消先记意图，再对原会话发送 `session/cancel`，确认停止和受管进程回收后才报告 `cancelled`，迟到的取消保留已确认结果。执行进程崩溃、回执丢失或对端断连时，缺少可信证据就保持 `unverified`，不重发 prompt、不换后端。ACP 的 `idempotencyKey` 只在对端仍保留该键时去重。

## 轨迹怎样进入平台

执行进程把 `session/update` 归一为按 `attemptId` 追加的有界事件，使用单次尝试内的递增序号。首版记录可展示的回复文本、工具名称与状态、执行生命周期及采集缺口。事件与制品分开存储，Agent 无权直接写事件库。仅持久化允许展示的字段，文本写入前脱敏。系统提示、凭据、内部思维和原始工具参数与输出不进入轨迹。

平台提供带尝试归属校验的游标查询。运行中可增量读取，终态后也可查历史。Flow Runtime 按节点访问关联的 `attemptId` 转读。断线或超限标记缺口。轨迹完整性与执行业务终态分别判断。

## 首发边界与切换条件

核查时 [ACP v2](https://agentclientprotocol.com/protocol/v2/overview) 仍处于 [Preview](https://agentclientprotocol.com/announcements/acp-v2-preview)，[schema](https://github.com/agentclientprotocol/agent-client-protocol/releases/tag/schema-v2.0.0-beta.3) 仍是预发布版。发布前固定通过验收的 schema、SDK 和对端版本。生产流程之外的协议义务和后续接入条件见 [ACP 基线与首版范围](ACP-SCOPE.md)。

1. **配置与链路验收。** 在隔离环境接通 Pi 的工作包直跑和 Flow 节点。通过真实执行验证冻结的系统指令、带相对路径的 Skill 配套文件、模型工具权限、事件增量读取和制品。验证非法节点结果不选边、跨角色读取返回 404。若保留整条 Flow 执行器，单独验证全程启停与制品。
2. **故障验收。** 注入回执丢失、更新先于回执、HTTP 重启、执行进程崩溃和取消竞态。每个 `attemptId` 最多提交一次任务。有证据时查回原结果，无证据时保持 `unverified`。仍有写入方时不得发布制品，采集缺口可见。
3. **一次性切换。** 停接旧执行请求并排空在途尝试，保留可查的已确认结果和制品。为新执行发布 ACP 修订，不改写旧后端绑定，也不从当前包补造旧快照从未保存的文件。切换时下线旧 MCP 执行程序、探测及配置入口，删除已无调用方的执行 SDK 依赖。移除旧程序后，做一次端到端验证，确认新任务的启动、查询和取消均不需要旧执行链路。
