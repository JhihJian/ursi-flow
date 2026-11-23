# 执行器 ACP v2 执行契约

平台作为 ACP Client，经本机 stdio 连接受管 Pi Agent。每个 `attemptId` 关联一个新会话和一次任务提交。本契约基于 [ACP v2 Preview beta.3](https://github.com/agentclientprotocol/agent-client-protocol/blob/schema-v2.0.0-beta.3/schema/v2/schema.json)。[协议基线与首版范围](ACP-SCOPE.md)另行列出生产流程以外的协议义务和可选能力。

## Agent 配置与生效条件

管理员通过执行器定义的 `configPackageId` 选择配置包。发布时固定解析后的后端和私有配置快照，草稿试跑只冻结当前尝试。运行时按 `executorRef` 读取已发布快照，工作包提供输入材料，调用方单独提交 `workInstruction`。

| 配置项 | 项目配置与冻结内容 | 执行时怎样生效 |
| --- | --- | --- |
| 系统提示词 | 编辑 `AGENTS.md`。冻结 UTF-8 正文及追加或替换语义。首版从现有 Pi 配置发布时采用替换语义。 | 平台按修订通过 `session/new.systemPrompt` 传递，Pi 将正文应用到实际系统上下文。任务指令另走 `session/prompt`。 |
| Skills 列表 | `skills/` 的直接子目录就是启用列表，每个 `skills/<id>/` 必须含 `SKILL.md`。冻结技能 ID、入口与纳入该目录的配套文件，保留相对路径和摘要。 | 平台按尝试只读装配，Pi 按冻结列表注册，允许通过受限的只读能力按相对路径读取对应配套文件。宿主和业务输入目录不参与技能发现。 |
| MCP 工具 | 在 `mcp.json.tools` 填选管理员已经授权的只读业务工具 ID，省略则业务工具列表为空。冻结每个 `{id, schemaDigest}`。 | Pi 只把所选业务工具注册给模型。工具调用前复核当前授权与远端参数 schema。权限被撤销或 schema 漂移时拒绝调用。 |
| 模型 | `mcp.json.modelProfile` 选择管理员登记的模型。省略时在冻结时解析为部署策略的默认模型 ID。 | Pi 从受管策略解析该 ID 及连接配置。模型和 MCP 的接入地址、命令及凭据留在管理员控制的部署配置中。 |

启动受管 Pi 时，平台通过本机私有只读文件交付 Skills、工具和模型引用。Pi 核对快照及文件摘要。配置包的 `mcpServers` 只允许省略或空对象。ACP 的 `session/new.mcpServers` 是服务列表，不承载项目的工具白名单。受管 Pi 通过既有业务工具客户端访问 MCP。平台到执行器之间只用 ACP 管理会话和执行。

发布和试跑时校验配置完整性、路径边界和模型、工具授权。执行时，Pi 核验快照及工作区，应用系统指令并注册技能和工具后，才返回 `sessionId`。装配失败时拒绝建会话，平台不提交任务。远端 MCP 工具的授权与 schema 在实际调用前复核。

## 建立连接

| 方法 | 方向 | 执行契约 |
| --- | --- | --- |
| `initialize` | 平台发请求 | 指定 `protocolVersion: 2`、`info` 和 `capabilities: {}`。核对对端版本、`info` 和 `capabilities.session`。版本整数用于线上协商，schema 和对端版本由部署锁定。 |
| `session/new` | 平台发请求 | 传 Agent 环境下的绝对 `cwd` 和本修订的 `systemPrompt`。取得 `sessionId` 后持久绑定到 `attemptId`。 |

[`systemPrompt`](https://agentclientprotocol.com/protocol/v2/session-setup#system-prompt) 在 ACP 中是可选能力。有冻结系统指令的修订必须核对 `session.systemPrompt`，并发送非空 `text` 内容块数组。追加语义使用 `mode: "append"`。替换内置默认指令时使用 `mode: "override"`，并核对 `session.systemPrompt.mode.override`。缺少所需能力或实际装配失败时，在提交任务前拒绝。受管 Pi 单独控制工作区上下文发现和工具授权。

本机进程管理负责执行隔离，`cwd` 用于定位本次工作目录。

## 提交任务与接收轨迹

| 方法 | 方向 | 执行契约 |
| --- | --- | --- |
| `session/prompt` | 平台发请求 | 将 `workInstruction` 作为一个 `text` 块发送。发送前持久化提交意图和 `idempotencyKey`。回执的 `messageId` 确认消息已插入。 |
| `session/update` | Pi 发通知 | 使用下表中的更新关联本轮任务、记录生命周期及归一化轨迹。 |
| `session/request_permission` | Pi 可发请求 | 平台按标准回 `outcome: {outcome: "cancelled"}`，表示未选择任何授权项。工具所需权限在注册与调用时按部署策略验证。 |
| `$/cancel_request` | 双向通知 | 结束待决 RPC，例如撤回权限请求。原请求仍须按对应方法回应。已回应或未知的请求 ID 忽略。 |

双向消息循环分别处理响应、通知和反向请求。[stdio](https://agentclientprotocol.com/protocol/v2/transports#stdio) 使用 UTF-8，每行承载一条 JSON-RPC 消息。会话更新按接收顺序应用。prompt 回执可先于或晚于本轮更新。平台按请求 ID、会话 ID 和消息 ID 建立关联。查询按 `attemptId` 读尝试账本。回执丢失时只查回原任务。Pi 随消息保留 `idempotencyKey`，平台仍以持久提交记录为去重依据。

| 更新 | 平台处理 |
| --- | --- |
| `state_update` | 记录 `running`、`requires_action`、`idle` 和 `unknown` 前台状态，按本轮实时边界关联结束原因。`unknown` 表示当前活动不可观测。 |
| `user_message`、`user_message_chunk` | 按 `messageId` 关联插入回执，任务正文保留在原提交记录中。 |
| `agent_message`、`agent_message_chunk` | 归并并展示脱敏后的回复。按会话、实体类型、ID 区分整量替换和片段追加。 |
| `tool_call_update` | 按 `toolCallId` 合并工具名称与状态。受管 Pi 执行工具时报告更新。 |

轨迹存储只接收根会话的白名单字段，以尝试内递增序号提供增量读取。检测到采集断线或超限时记录缺口。扩展消息可忽略，终态和授权只由本契约认可的证据改变。

## 停止与终态

| 方法 | 方向 | 执行契约 |
| --- | --- | --- |
| `session/cancel` | 平台发通知 | 持久登记取消意图后，向原活跃会话发送一次。它请求停止前台工作和此前未插入的 prompt。 |
| `session/close` | 平台发请求 | 执行收尾时关闭会话，回收会话所拥有的活动与待决交互。平台另行确认本机写入方已停止。 |

| 结果 | 平台需要的证据 |
| --- | --- |
| `succeeded` | 本轮实时 `idle/end_turn`、写入方停止、制品校验通过。Flow 节点还须有一次合法的 `submit_flow_outcome`，由 Runtime 复验制品再选边。 |
| `failed` | 提交明确被拒绝，或本轮以 `max_tokens`、`max_turn_requests`、`refusal`、`error` 结束，并确认执行资源已停止。 |
| `cancelled` | 本轮 `idle/cancelled`，或取消使待插入的 prompt 返回 `-32800`，并确认执行资源已停止。迟到取消保留已确认结果。 |
| `unverified` | 缺少可信终态或停止证据，保留原尝试供查回。 |

用于判定终态的实时结束事件须关联到本轮。初始 `idle`、重复快照、关闭回执和单个工具状态各自不构成结束证据。`background` 省略或 `null` 表示未报告，写入方停止由进程监督确认。

## 验收

1. 发布修订后分别更改包内 `AGENTS.md`、Skills 列表、配套文件和 `mcp.json.tools`。旧修订仍使用冻结配置，新试跑使用新配置。检查模型实际收到的系统指令和工具列表，并验证选中的 Skill 能读到冻结的配套文件。配置装配失败或协商能力不符时，断言未发送 `session/prompt`。
2. 用测试 MCP 服务验证选中的工具可调用，未选工具不暴露给模型。撤权或参数 schema 变化后，下一次调用必须拒绝，远端不得收到 `tools/call`。
3. 验证 v2 初始化、文本任务、标准关闭和权限拒绝。覆盖回执和更新的两种到达顺序，以及 Pi 对同键提交的去重。其余基线验收见[基线能力](ACP-SCOPE.md#pi-仍须实现的会话基线)。
4. 验证增量轨迹、回执丢失、服务重启、执行进程崩溃和取消竞态，核对原任务至多提交一次、无停止证据不发布、非法 Flow 结果不选边。
