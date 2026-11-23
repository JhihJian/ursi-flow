# ACP v2 基线与首版范围

[执行契约](ACP-PROFILE.md)规定平台生产流程使用的能力。本文件记录该流程之外的 Pi 协议基线、暂不启用的可选项，以及平台可以忽略的报告。分类依据 [beta.3 基线 schema](https://github.com/agentclientprotocol/agent-client-protocol/blob/schema-v2.0.0-beta.3/schema/v2/schema.json)和[实验 schema](https://github.com/agentclientprotocol/agent-client-protocol/blob/schema-v2.0.0-beta.3/schema/v2/schema.unstable.json)。

## Pi 仍须实现的会话基线

Pi 声明 `capabilities.session` 就须实现[七个基线方法](https://agentclientprotocol.com/protocol/v2/initialization#session-capabilities)。以下两个方法和资源链接属于 Pi 的 ACP 互操作验收。平台按 `attemptId` 查账本，业务轨迹来自实时持久化记录。

| 能力 | Pi 实现与验收 |
| --- | --- |
| `session/list` | 返回有权访问且仍保留的会话。验证目录过滤和无匹配结果。 |
| `session/resume` | 校验原 `cwd`，验收时重送原配置。省略 `replayFrom` 时先同步现态再回应。指定 `{type: "start"}` 时回放保留历史，再发送 `replay_complete`、同步现态并回应。基线允许有界留存，已丢弃的会话按协议拒绝。回放只证明对端交付了保留的历史，任务终态以尝试账本为准。 |
| `resource_link` | 在 prompt 中接受资源引用。引用不会扩大文件或网络访问权限。 |

## 首版范围外的基线 schema 能力

| 能力 | 协议条件或含义 |
| --- | --- |
| `auth/login`、`auth/logout` | 非空 `authMethods` 要求 Agent 支持两者。终端认证还需 Client 声明 `auth.terminal`。首版模型凭据由部署注入。 |
| `session/set_config_option` | Agent 公布 `configOptions` 后须实现。首版由执行器修订固定运行配置。 |
| `session/delete` | 需 `session.delete`。关闭会话与删除历史是独立操作。 |
| `tool_call/cancel`、`terminal/cancel` | 需对应工具调用或终端声明 `capabilities.cancel`。首版按整次尝试取消。 |
| `elicitation/create`、`elicitation/complete` | `create` 由 Client 的 `elicitation.form` 或 `elicitation.url` 门控，`complete` 用于已协商的 URL 交互。首版执行不等待这些交互。 |
| 图片 `image`、音频 `audio`、内嵌资源 `resource` | 分别由 `session.prompt.image`、`session.prompt.audio`、`session.prompt.embeddedContext` 门控。 |
| `additionalDirectories` | 增加 Agent 可用的工作区根，需 `session.additionalDirectories`。 |
| `mcpServers` | 会话可按 `session.mcp.stdio` 或 `session.mcp.http` 连接 MCP 服务。它与 ACP 自身的 stdio 传输独立。项目的[只读 MCP 工具白名单](ACP-PROFILE.md#agent-配置与生效条件)独立于此能力。 |
| 命令发现与调用 | 可用命令通过 `availableCommands` 和 `available_commands_update` 公布。首版任务作为原始文本执行，不展开 slash command 或提示模板。 |

v2 已移除 v1 的 `fs/read_text_file`、`fs/write_text_file` 和客户端代跑终端方法。输入和制品由平台托管工作区交付，diff 和终端输出属于报告。[v2 迁移说明](https://agentclientprotocol.com/protocol/v2/migration)

## 不进入平台轨迹的标准报告

| 更新 | 含义与边界 |
| --- | --- |
| `replay_complete` | 只用于基线回放验收，标记已发完选入回放的历史。 |
| `tool_call_content_chunk`、`agent_thought`、`agent_thought_chunk` | 工具内容和内部思维不进入公开轨迹。 |
| `terminal_update`、`terminal_output_chunk` | Agent 终端的报告，不用于制品交付或本机进程回收判定。 |
| `plan_update`、`plan_removed`、`available_commands_update` | 计划与可用命令信息。 |
| `config_option_update`、`session_info_update`、`usage_update` | 动态配置、会话元信息和用量。不用于定位尝试、修改冻结配置或计费。 |
| `notice` | 实时提示，`error` 级别不等于任务失败。 |
| `compaction_update`、`compaction_summary_chunk` | 上下文压缩及其摘要。 |
| `subagent_update`、`session_message`、`session_message_chunk` | 子会话和会话间消息。首版后端只运行根会话的单个任务，不启动子会话或独立后台工作。 |

## 实验功能

首版锁定基线 schema。实验功能按各自的能力规则协商，`protocolVersion: 2` 不会自动启用它们。

| 功能 | 实验方法及载荷 |
| --- | --- |
| 会话扩展 | `session/fork`、`session/archive`、`session/unarchive`、`session/status`、`session/options`、`session/set_title`，以及初始配置选项、`cursor_update`。 |
| 认证状态 | `auth/status`、`auth/status_update`。 |
| 模型供应商管理 | `providers/list`、`providers/set`、`providers/disable`。 |
| MCP 隧道 | `mcp/message`，在两个方向上定义。 |
| 代理链 | `proxy/initialize`、`proxy/successor`。 |
| Skills | `skill` 内容块及可用命令。Client 的 `session.commands.skill` 和 Agent 的 `session.prompt.skill` 分别协商，用于发现和调用已加载技能。首版用本机只读文件装配。 |
| 其他实验载荷 | `prompt_suggestions_update`、完成时的 `usage` 数据。 |

## 异机与沙箱接入

现有[沙箱 ACP](../../../ursi-sandbox/bundles/pi-agent/AGENT-CONTRACT.md#acp-子集) 是 v1 WebSocket 子集。异机后端准入要求可核验的配置装配、按尝试授权的文件交付，以及可持久查回的任务终态和停止证据。标准会话恢复达不到这些要求时，可经[能力协商](https://agentclientprotocol.com/protocol/v2/extensibility)扩充原尝试的证据查询。
