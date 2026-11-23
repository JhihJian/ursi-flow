---
parent: ../../SPEC.md
references:
  - ../../docs/flow-spec.md
  - ../../../docs/design/executor-platform/ACP-PROFILE.md
  - ../../../docs/design/executor-platform/ACP-SCOPE.md
  - ../../../docs/design/workbench/PI-AGENT-EXECUTOR-DESIGN.md
---

# Pi 执行器

## 功能意图

Pi 在 Linux 上为执行器平台提供 ACP 会话。生产进程按一次尝试装配冻结配置，至多插入一次工作指令，并报告前台状态、回复和工具进度。平台负责持久记录尝试、监督进程和收集制品。

## 关键功能与验收

### ACP 连接与会话装配

#### 验收

- 走本机 stdio UTF-8 JSONL，标准输出仅承载 JSON-RPC。`initialize` 按 ACP v2 Preview beta.3 校验客户端 `info`，协商 `protocolVersion: 2`，返回 Agent `info` 和 `session.systemPrompt.mode.override` 能力。
- 生产进程读取 `URSI_ACP_JOB` 指向的私有 `0400` JSON 文件，使用其中的 `cwd`、`configDigest` 和可选 `nodeContract`。`cwd` 必须绑定到 `<URSI_EXECUTOR_ROOT>/<attemptId>/workspace`。同级 `agent-config.json` 权限为 `0400`，原始字节的 SHA-256 与 `configDigest` 一致。文件须为单链接的普通文件，目录须私有且为真实路径。装配失败时不调用模型。
- 无作业文件时，可用执行根目录下预先建立的私有工作目录开启通用会话。通用会话选用策略中首个模型，支持多次提交，不加载工作区上下文、文件工具或业务工具，也不写制品。
- `session/new.systemPrompt` 的文本实际进入模型的系统上下文。`override` 替换默认系统指令，`append` 追加到默认系统指令；冻结 Skills 单独装配。工作指令仍作为用户消息。`resource_link` 可随消息插入，链接本身不触发文件读取或网络请求，也不授予访问权限。

### 插入回执、取消与回放

#### 验收

- `session/prompt` 接受有效内容后以 `messageId` 确认插入，模型未完成也可收到回执。对应用户消息更新复用该 ID。生产作业已有一次成功插入后，继续提交非重复指令会被拒绝。重试仍保留的 `idempotencyKey` 返回原 `messageId`，不再插入或运行。
- 前台工作通过 `session/update` 报告 `running` 和带结束原因的 `idle`。运行中的 `session/cancel` 中止当前会话，确认中止后报告 `idle/cancelled`，不交付部分结果。生产完成与写入方退出由平台结合实时终态与进程回收证据确认。
- 工具执行通过 `tool_call_update` 报告名称和状态。同一次调用的更新共用 Agent 生成的 `toolCallId`，响应不含原始工具参数、输出或供应商调用 ID。
- `session/close` 停止该会话的活动，保留进程内可回放记录。`session/list` 支持按 `cwd` 过滤。`session/resume` 校验会话和原 `cwd`；指定 `{type: "start"}` 时先回放保留的历史、再发送 `replay_complete`；无论是否请求回放，均在回应前同步当前状态。平台不以会话回放替代持久尝试记录。

### 冻结资源与制品

#### 验收

- 模型和只读业务工具来自 `URSI_PI_POLICY`。生产会话按快照中的 `modelProfile` 和 `{id,schemaDigest}` 装配，调用业务工具前重新核对当前授权和远端 schema。SDK 内置工具与工作区资源发现关闭。
- Skill 快照包含标识、整数修订、入口正文和可选配套文件。装配时核验附件相对路径和 SHA-256。`read_skill_file` 只接受冻结 Skill 的 `{skillId,path}`，有效 UTF-8 返回文本，二进制返回 Base64。任务输入通过受限的 `list_inputs` 和 `read_input` 读取 `inputs/`。
- 普通生产会话正常结束后发布 `workspace/artifacts/answer.md`。Flow 节点仅在已冻结 `nodeContract` 时提供 `submit_flow_outcome`，且会话正常结束并恰有一次合法提交时才发布 `workspace/artifacts/flow-outcome.json`。结果和变量限于契约声明，缺省变量归一为 `{}`。两类制品均不覆盖已有文件。
