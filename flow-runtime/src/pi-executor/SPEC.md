---
parent: ../../SPEC.md
references:
  - ../../../workbench/EXECUTOR-MCP.md
  - ../../../workbench/PI-AGENT-EXECUTOR-DESIGN.md
---

# Pi 执行器

## 功能意图

`ursi-pi-executor-mcp` 在 Linux 上执行 Workbench 已冻结的 Agent 配置。每次尝试最多调用一次 Pi 会话；关闭 stdio、重启工作台或丢失启动回执后，仍可凭原 ID 查询和取消。

## 关键功能与验收

### 任务身份与私有配置

#### 验收

- 三个工具、参数、响应和公开错误码遵循 Workbench 执行器 MCP 契约。`backendRunRef` 为 `pi:<attemptId>`。协议响应不含宿主路径、配置正文或凭据。
- `<URSI_EXECUTOR_ROOT>/<attemptId>/agent-config.json` 与业务工作区分开。配置、尝试目录和工作区属于当前用户且私有；拒绝符号链接、硬链接文件和特殊文件。模型与业务工具授权来自 `URSI_PI_POLICY` 指定的绝对私有文件。
- 快照最多 2 MiB；校验 `systemPrompt`、`modelProfile`、Skill 的标识、整数修订和正文，以及工具标识和 SHA-256 schema 摘要。额外字段参与快照身份校验，但不传给 SDK。单次任务文本独立于固定指令，最多 256 KiB。

### 持久登记与故障核实

#### 验收

- 在根目录的 SQLite 账本中原子登记 ID、指令摘要、快照摘要及目录身份，再启动独立 Node 进程。并发启动或跨进程重试返回同一次尝试；已登记 ID 更换指令、快照或工作区绑定时返回 `conflict`。
- 同一根目录最多受理 8 个待启动及运行中的尝试。满额时新 ID 返回 `busy`，释放名额后可再启动。重复查询或启动原 ID 不占第二个名额。
- 15 秒内未领取的登记、已消失的 worker 和无完成证据的会话均报 `unverified`。核实 worker 使用 Linux boot ID、PID 和进程启动时钟。查询、取消及重复启动均不重放 prompt。

### 取消、超时与终态

#### 验收

- 取消先登记请求。worker 在调用会话前看到请求，或运行中的会话明确确认中止并停止后，才能返回 `cancelled`。会话已成功或失败时，晚到的取消保留原结果。
- 单次会话限时 30 分钟。超时向当前会话发送中止信号，确认中止记为 `failed`。5 秒内未响应则终止当前 worker 持有的会话线程，记为 `unverified`。不向账本中记录的 PID 发送信号。
- 写入已确认终态前先结束会话线程，后续查询只返回已记录的状态，供平台收集制品。
