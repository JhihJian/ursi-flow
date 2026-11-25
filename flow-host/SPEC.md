---
parent: ../SPEC.md
depends-on:
  - ../flow-runtime/SPEC.md
  - ../flow-core/SPEC.md
  - ../executor-sdk/SPEC.md
  - ../executor-platform/server/SPEC.md
references:
  - ../flow-core/docs/flow-spec.md
  - ../docs/EXECUTOR-MCP.md
  - ../workbench/EXECUTOR-INTEGRATION.md
  - ./README.md
---

# Flow Host

## 功能意图

Flow 的进程宿主：管理本机包目录与修订、运行登记、后台 worker、运行配置、执行器绑定与调用、会话轨迹与 MCP adapter。推进语义由 [Flow Runtime](../flow-runtime/SPEC.md) 与 Flow Core 提供，宿主通过 `~/.ursi-flow/runtime.sock` 把能力交给 Workbench、CLI 与 MCP 客户端。

## 关键功能与验收

### 包目录与原子修订

#### 验收

- 已发布的包位于 `versions/v1/<Flow ID>/`，`v1` 表示 Flow 规范格式版本；校验通过后才原子切换当前目录，历史修订留在 `.revisions/<修订>/`。
- `flow.list` 只返回标识；`flow.get` 返回单个包的文件。单个包解析失败只影响该包的读取，不影响其他条目。
- 校验不改变当前修订；非法更新保留原修订；提交过期修订返回 `conflict`。
- 发布的包包含 `FLOW.md` 和按包内相对路径提供的文本附件，路径不能越过包根，文件与目录不能重名。

### 运行登记与工作目录

#### 验收

- 配置里 `workspace` 必须是绝对路径，保存时建目录；留空表示必须为每次运行指定目录。
- 不带 `cwd` 启动时，运行目录为 `<workspace>/<Run ID>` 的真实路径，工作区根目录不存在时自动创建；命令与本地 Pi Agent 在该目录下执行。
- 显式 `cwd` 优先，且必须是已存在的目录，否则返回 `invalid_request`。
- 既无 `cwd` 又无 `workspace` 时返回 `invalid_request`，消息指出可去运行配置填写工作区根目录。
- 同一 Run ID 重试要求 Flow、解析后的工作目录、变量与修订一致，换任一项返回 `conflict`，不重复执行。
- 固定修订启动与目录发布串行处理；即使只有其他 Flow 更新，旧修订也返回 `conflict`，不登记 Run、不产生节点历史。

### 运行证据与会话轨迹

#### 验收

- 通过本地 Pi 执行的每次 Agent 节点都在运行目录的 `trajectories/` 留下 `<节点执行 ID>.jsonl` 会话切片，条目保留原始 `id`/`parentId`，首行是合成会话头；写入轨迹失败不改变节点结果。
- `run.trajectory` 按节点执行读取切片，文件不存在返回 `not_found`，超过 8 MiB 只返回大小与 `omitted`；CLI 的 `run trajectory` 直接读取同一份文件。
- `run.history` 返回运行记录与全部事实集合，包含运行时的定义快照；Flow 之后被改动或删除不影响已完成的运行。

### 人工确认门禁的通道

#### 验收

- 挂起时 `run.get` 返回 `waiting_input`，节点执行记录带 `pendingInput`（渲染文本与全部结果边名），不消耗模型调用。
- `run.respond` 校验等待状态、节点匹配与结果合法性：非法或重复应答被拒绝且不改变等待状态；合法应答按该结果完成节点并继续路由。CLI 入口为 `ursi-flow run respond`。
- 等待中停止运行正常终止；恢复运行重新渲染提示并再次挂起，旧等待作废。

### 将 Agent 节点交给平台执行

`run.start` 和 `run.startPinned` 可指定 `executorRef: {id, revision}`。引用固定到整个 Run（含子 Flow），参与 Run ID 冲突检查。省略引用使用本地 Pi。

#### 验收

- 平台模式不需要本地模型 provider。仅支持独立的 `新建Agent` 访问，预检整个引用闭包，拒绝复用会话、本地 Agent 装配能力与包内 references 链接。平台令牌不进入 Run 记录。
- 每次访问先保存新的 `attemptId`，然后 `PUT /api/v2/executor-attempts/{attemptId}`。正文包含 `workInstruction: {text, encoding: "utf-8"}`、固定的 `executorRef` 和 `runConfig.nodeContract: {outcomes, variables}`。
- 启动回执丢失后只 GET 原尝试。daemon 重启后 `run.resume` 使用原平台和已记录的 ID 核实结果，同一次节点访问不会重复启动。未确认状态不触发路由。
- `run.stop` 通过同一路径的 `/cancel` 发起 POST。未确认停止时返回 `unknown` 并记录取消意图，此后可重试停止，不能恢复路由。
- `succeeded` 后按 `GET /api/v2/directories/{artifactDirectoryId}/file?path=flow-outcome.json` 读取结构化结果。只有 `outcome` 合法且 `variables` 符合所选结果的声明才选边；缺失或非法的结果文件使节点失败。

### Flow Executor MCP stdio adapter

Flow Host 通过独立执行器 SDK 为 MCP 客户端提供整条 Flow 的 stdio JSONL adapter，独立于执行器平台。adapter 只暴露 `executor_start`、`executor_inspect`、`executor_cancel`，复用 daemon 的 `run.startPinned`、`run.get` 和 `run.stop`，不复制运行状态机。管理员通过 `URSI_EXECUTOR_ROOT`、`URSI_EXECUTOR_FLOW`、`URSI_EXECUTOR_FLOW_REVISION` 和 `URSI_FLOW_HOME` 固定执行边界。

#### 验收

- 按[执行器 MCP 协议](../docs/EXECUTOR-MCP.md)，`executor_start` 接受小写标准 UUID、与该 ID 绑定的两个目录引用、字符串 `workInstruction` 和可选 JSON 对象 `runConfig`。固定修订的 Flow 适配器未定义运行配置字段，省略或 `{}` 使用部署配置，其他值返回 `invalid`。
- 成功工具结果的 `structuredContent` 与唯一 JSON text 内容相同，包含 `attemptId`、`status`、`artifactDirectoryRef`，并可包含区分后端的 `backendRunRef`；状态只使用 `running`、`succeeded`、`failed`、`cancelled`、`unverified`。
- 工具失败使用 `isError: true`，text 只包含允许的 JSON 错误码 `invalid`、`conflict`、`not_found`、`busy` 或 `unavailable`，不回传路径、凭据或 daemon 原始错误。
- adapter 将 `<URSI_EXECUTOR_ROOT>/<attemptId>/workspace` 作为 cwd，并使用其中的 `artifacts/`；调用 inspect/cancel 前确认真实目录、拒绝符号链接、验证当前用户所有权以及 daemon job 的 ID、Flow、revision、cwd 和任务身份。
- stdio 生命周期遵循 MCP `initialize`、`notifications/initialized`、`tools/list`、`tools/call`，每个请求一行 JSON，每个响应一行 JSON；解析错误、协议错误和 stdin 关闭都能干净处理。

### 推进与历史都来自引擎

#### 验收

- daemon 与 CLI 都通过 [Flow Runtime](../flow-runtime/SPEC.md) 的引擎推进：Agent 节点交给执行器会话，命令节点交给子进程，并行分支并发执行。宿主不再保留第二套协调器。
- 运行状态由引擎快照推导，`job.json` 只保存受理意图。`run.history` 把过程日志投影成 `runs`、`nodeRuns`、`routeDecisions`、`parallelRounds`、`recoveries`，供 Workbench 与 CLI 读取。
- 平台执行器按 `stepId` 保存 `attemptId`，`unverified` 时 Run 为 `unknown`，`run.resume` 只查询并核实原尝试；确认取消后才记停止事实。
- 命令参数中独立的 `scripts/...` 按包根定位，其他参数原样传递；命令进程的工作目录是本次运行的工作目录。
