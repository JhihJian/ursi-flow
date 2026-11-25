# 执行器 ACP v2 执行契约

平台为每个 `attemptId` 启动独立 worker。worker 作为 ACP Client 经本机 stdio 连接受管 Agent，在新会话中至多提交一次任务。本契约基于 [ACP v2 Preview beta.3](https://github.com/agentclientprotocol/agent-client-protocol/blob/schema-v2.0.0-beta.3/schema/v2/schema.json)。[协议基线与首版范围](ACP-SCOPE.md)另行列出生产流程以外的协议义务和可选能力。

## Agent 配置与生效条件

管理员通过执行器定义的 `configPackageId` 选择配置包。发布时固定解析后的后端和私有配置快照，草稿试跑只冻结当前尝试。运行时按 `executorRef` 读取已发布快照，工作包提供输入材料，调用方单独提交 `workInstruction`。

| 配置项 | 项目配置与冻结内容 | 执行时怎样生效 |
| --- | --- | --- |
| 系统提示词 | 编辑 `AGENTS.md`。冻结 UTF-8 正文。平台生产流程统一使用 `override` 替换语义。 | 平台按修订通过 `session/new.systemPrompt` 传递，Agent 将正文应用到实际系统上下文。任务指令另走 `session/prompt`。 |
| Skills 列表 | `skills/` 的直接子目录就是启用列表，每个 `skills/<id>/` 必须含 `SKILL.md`。冻结技能 ID、入口与纳入该目录的配套文件，保留相对路径和摘要。 | Agent 按冻结列表注册；会话通过 `read_skill_file` 以相对路径读取快照内的配套文件。宿主和业务输入目录不参与技能发现。 |
| MCP 工具 | 在 `mcp.json.tools` 填选管理员已经授权的只读业务工具 ID，省略则业务工具列表为空。冻结每个 `{id, schemaDigest}`。 | Agent 只把所选业务工具注册给模型。工具调用前复核当前授权与远端参数 schema。权限被撤销或 schema 漂移时拒绝调用。 |
| 模型 | `mcp.json.modelProfile` 选择管理员登记的模型。省略时在冻结时解析为部署策略的默认模型 ID。 | Agent 从受管策略解析该 ID 及连接配置。模型和 MCP 的接入地址、命令及凭据留在管理员控制的部署配置中。 |

平台为正式尝试生成私有只读的 `agent-config.json` 和作业文件。`URSI_ACP_JOB` 指向该作业文件，其中的 `cwd` 定位本次 `workspace/`，`configDigest` 固定快照的 SHA-256，可选 `nodeContract` 固定 Flow 节点的结果和变量声明。Agent 核对快照与附件摘要；业务输入和输出分别位于 `workspace/inputs/` 和 `workspace/artifacts/`。配置包的 `mcpServers` 只允许省略或空对象。ACP 的 `session/new.mcpServers` 是服务列表，不承载项目的工具白名单。Agent 通过既有业务工具客户端访问 MCP。平台到执行器之间只用 ACP 管理会话和执行。

发布和试跑时校验配置完整性、路径边界和模型、工具授权。执行时，Agent 核验快照及工作区，应用系统指令并注册技能和工具后，才返回 `sessionId`。装配失败时拒绝建会话，平台不提交任务。远端 MCP 工具的授权与 schema 在实际调用前复核。

## 后端预检与建立连接

平台用部署登记的程序和策略，在私有临时工作区执行预检：协商 v2，核对替换提示词能力，使用测试提示词建立并关闭临时会话，再确认进程已回收。预检只验证临时会话，不装配生产作业或提交 `session/prompt`。检查结果为 `ready` 或 `failed`；正式尝试由 worker 重新协商并装配所选修订。

| 方法 | 方向 | 执行契约 |
| --- | --- | --- |
| `initialize` | 平台发请求 | 指定 `protocolVersion: 2`、`info` 和 `capabilities: {}`。核对对端版本、`info` 和 `capabilities.session`。版本整数用于线上协商，schema 和对端版本由部署锁定。 |
| `session/new` | 平台发请求 | 传 Agent 环境下的绝对 `cwd` 和本修订的 `systemPrompt`。取得 `sessionId` 后持久绑定到 `attemptId`。 |

[`systemPrompt`](https://agentclientprotocol.com/protocol/v2/session-setup#system-prompt) 是 ACP 的可选能力，也是平台的接入要求。平台核对 `capabilities.session.systemPrompt.mode.override` 后，发送 `mode: "override"` 和包含冻结正文的非空 `text` 内容块数组。能力不符或装配失败时不提交任务。`cwd` 只定位工作目录，程序和策略由部署者控制，本机进程组用于确认受管写入方已停止。

## 提交任务与接收轨迹

| 方法 | 方向 | 执行契约 |
| --- | --- | --- |
| `session/prompt` | 平台发请求 | 将 `workInstruction` 作为一个 `text` 块发送。发送前持久化提交意图和 `idempotencyKey`。回执的 `messageId` 确认消息已插入。 |
| `session/update` | Agent 发通知 | 使用下表中的更新关联本轮任务、记录生命周期及归一化轨迹。 |
| `session/request_permission` | Agent 可发请求 | 平台按标准回 `outcome: {outcome: "cancelled"}`，表示未选择任何授权项。工具所需权限在注册与调用时按部署策略验证。 |

双向消息循环分别处理响应、通知和反向请求。[stdio](https://agentclientprotocol.com/protocol/v2/transports#stdio) 使用 UTF-8，每行承载一条 JSON-RPC 消息。平台在发送 `session/new` 前开始接收更新。建会话期间早到的更新暂存于限制条数和字节数的缓冲区。持久绑定 `attemptId` 与 `sessionId` 后，只按接收顺序处理匹配根会话的更新。

本轮更新可先于或晚于 prompt 回执，包括结束通知。worker 用请求 ID 和根会话 ID 关联消息，若收到用户消息回显，其 `messageId` 须与回执一致。回执只确认插入；常规终态还要求本轮活动后收到实时结束原因。回执未到时，worker 短暂等待迟到回执。等待结束或连接正常断开后，只有已收到消息回显与可信结束证据时才可能查回终态，否则保持 `unverified`。平台按 `attemptId` 查账本，从不重发任务；Agent 对仍保留的 `idempotencyKey` 去重。

| 更新 | 平台处理 |
| --- | --- |
| `state_update` | 记录 `running`、`requires_action`、`idle` 和 `unknown` 前台状态，按本轮实时边界关联结束原因。`unknown` 表示当前活动不可观测。 |
| `user_message`、`user_message_chunk` | 按 `messageId` 关联插入回执，任务正文保留在原提交记录中。 |
| `agent_message`、`agent_message_chunk` | 提取回复文本与消息 ID，分别作为整量消息与片段记录。 |
| `tool_call_update` | 保留调用 ID、可用的名称与状态，逐条记录。 |

## 归一化事件分页

调用 `GET /api/v2/executor-attempts/{id}/events?after=0` 读取 `{events, nextCursor}`。`after` 是非负序号，默认 `0`；每页最多 64 条。以 `nextCursor` 续读，空页保持输入游标。平台按尝试归属校验权限，未认证返回 401，其他角色（含管理员）或未知尝试返回 404。旧协议尝试立即返回空页。

`waitMs` 是可选的非负整数，默认 `0`，超过 8000 按 8000 毫秒处理。游标之后已有记录时立即返回。仅当页为空且首次读取观察到 worker 持锁运行时，平台才等待下一条记录、worker 停止或固定期限届满。等待期间取消和状态查询可正常执行，响应格式保持不变。

| `kind` | `seq` 之外的字段 |
| --- | --- |
| `rpc` | `method`，`phase` |
| `state` | `state`，可选的 `stopReason` |
| `message` | `messageId`、`chunk`、`text` |
| `tool` | `toolCallId`，可选的 `name`、`status` |
| `gap` | `reason`，例如 `early_update_limit`、`retention_limit` 或 `worker_lost` |

`rpc.method` 取 `initialize`、`session/new`、`session/prompt`、`session/cancel` 或 `session/close`。`sent` 表示完整消息已写入 stdio；`ack` 表示收到并通过校验的对应成功响应；`failed` 表示发送失败，或在该方法的处理期限内未获有效成功响应，包括错误响应和回执丢失。`session/cancel` 是通知，阶段仅为 `sent` 或 `failed`。`session/prompt` 回执缺失仍可能由独立证据确认任务结果。RPC 记录只公开方法和阶段，参数、请求与会话 ID、结果和错误详情均留在事件之外。

接口按序逐条返回归一化记录，保留消息片段和工具状态更新的边界；原始 ACP 帧留在传输层。Agent 在发送显示文本前过滤已知敏感值，worker 按字段白名单及大小上限写入，用户消息正文、内部思维、系统提示和原始工具参数与输出不作为事件字段。已提交记录按尝试内递增的 `seq` 可读，重启后游标不变。每次尝试最多留存前 512 条记录；若还有后续事件，以一条 `retention_limit` 标记留存缺口。可记录的采集缺口用于说明轨迹不完整，事件页与终态判定相互独立。

## 停止与终态

| 方法 | 方向 | 执行契约 |
| --- | --- | --- |
| `session/cancel` | 平台发通知 | 持久登记取消意图后，向原活跃会话发送一次。它请求停止前台工作和此前未插入的 prompt。 |
| `session/close` | 平台发请求 | 执行收尾时关闭会话，结束该会话的活动及待决交互。 |

建立会话后，worker 在收尾时限时请求 `session/close`，随后关闭 stdio 并回收受管进程组，即使关闭请求超时也继续回收。worker 确认受管进程组停止后才记录已确认终态。服务端读取该终态后收集制品，收集可按原 ID 继续。

| 结果 | 平台需要的证据 |
| --- | --- |
| `succeeded` | 本轮实时 `idle/end_turn`、写入方停止、制品校验通过。Flow 节点还须有一次合法的 `submit_flow_outcome`，由 Runtime 复验制品再选边。 |
| `failed` | 后端启动、建会话或任务提交明确失败，本轮以 `max_tokens`、`max_turn_requests`、`refusal`、`error` 结束，或制品校验失败。须确认没有活跃的受管写入方；非法制品不发布。 |
| `cancelled` | 已在提交前取消，或本轮 `idle/cancelled`，或取消使待插入的 prompt 返回 `-32800`。须确认没有活跃的受管写入方。迟到取消保留已确认结果。 |
| `unverified` | 缺少可信终态或停止证据，保留原尝试供查回。 |

用于判定终态的实时结束事件须关联到本轮。初始 `idle`、重复快照、关闭回执和单个工具状态各自不构成结束证据。`background` 省略或 `null` 表示未报告，写入方停止由进程监督确认。

## 验收

1. 发布 ACP 修订后分别更改包内 `AGENTS.md`、Skills 列表、配套文件和 `mcp.json.tools`。已发布的 ACP 修订仍使用冻结配置，新试跑使用新配置。检查模型实际收到的系统指令和工具列表，并验证选中的 Skill 能读到冻结的配套文件。配置装配失败或协商能力不符时，断言未发送 `session/prompt`。
2. 用测试 MCP 服务验证选中的工具可调用，未选工具不暴露给模型。撤权或参数 schema 变化后，下一次调用必须拒绝，远端不得收到 `tools/call`。
3. 注入版本或能力不符、建会话失败和预检回收超时，验证未就绪的后端不能用于新发布和试跑，预检全程不发送任务。另验证标准权限拒绝和 Agent 对同键提交的去重。其余基线验收见[基线能力](ACP-SCOPE.md)。
4. 注入建会话回执前的更新、prompt 回执前后的结束通知，以及回执丢失。核对早到更新按根会话顺序入账，初始或重复的 `idle` 与其他会话的更新不作为本轮终态证据，原任务至多提交一次。
5. 验证原角色可用原游标增量读取已提交记录，跨角色返回 404。验证短时等待由新记录或 worker 停止唤醒，同一尝试仍可取消；注入带私有详情的 RPC 错误并核对事件字段。覆盖缓冲和留存超限，核对缺口与终态分开记录。
6. 注入关闭超时、主进程退出但子进程仍写入、服务重启、执行进程崩溃和取消竞态。缺少停止证据时保持 `unverified`，不发布制品。非法 Flow 结果不选边。

## 实现参考

PlanWeave 的[分阶段预检](https://github.com/GaosCode/PlanWeave/blob/42d38130590a0d29ee9dae9a95a4b62728a17f4d/packages/runtime/src/autoRun/acpPreflightProbe.ts#L175)、[早到更新处理](https://github.com/GaosCode/PlanWeave/blob/42d38130590a0d29ee9dae9a95a4b62728a17f4d/packages/runtime/src/autoRun/acpExecutionEngine.ts#L291)、[先写入再发布](https://github.com/GaosCode/PlanWeave/blob/42d38130590a0d29ee9dae9a95a4b62728a17f4d/packages/runtime/src/autoRun/acpEventStore.ts#L278)和[连接清理](https://github.com/GaosCode/PlanWeave/blob/42d38130590a0d29ee9dae9a95a4b62728a17f4d/packages/runtime/src/autoRun/acpConnectionLease.ts#L229)提供实现参考。这里沿用处理顺序，终态遵循 v2 的实时状态证据，不使用 PlanWeave v1 的 prompt 响应 `stopReason`。
