---
parent: ../SPEC.md
depends-on:
  - ../executor-sdk/SPEC.md
  - ../executor-platform/server/SPEC.md
references:
  - docs/flow-spec.md
  - ../docs/EXECUTOR-MCP.md
  - ../workbench/EXECUTOR-INTEGRATION.md
---

# Flow Runtime

## 功能意图

独立于 Rust 服务执行 FLOW.md 包。引擎决定路由，宿主实现命令与 Agent 调用。运行记录保留每次节点执行和结果。日常操作可由 [Web 控制台](web/SPEC.md) 或 CLI 完成。

## 关键功能与验收

### 流程定义与本地运行

加载 Flow 包及其引用闭包，校验图、动作和变量，根据结果边推进；节点需要的能力由宿主预检。

#### 验收

- 参考解析用例可直接运行。缺失资源、非法图和子 Flow 引用环在运行前拒绝。
- 新建和复用节点使用同一 Pi 会话；独立工具回执驱动下一跳，历史记录保留每次 outcome。
- 在无 Rust workspace、Server、Gateway 的目录安装打包产物，能加载示例。

### 运行证据与会话轨迹

#### 验收

- daemon 通过本地 Pi 执行的每次 Agent 节点都在运行目录的 `trajectories/` 留下 `<节点执行 ID>.jsonl` 会话切片，条目保留原始 `id`/`parentId`，首行是合成会话头；运行中的节点只能读到已产生的部分。
- `run.trajectory` 按节点执行读取切片，文件不存在返回 `not_found`，超过 8 MiB 只返回大小与 `omitted`；写入轨迹失败不改变节点结果。
- 模型连续三次提交节点不允许的结果时本轮结束，节点失败原因保留最后一次拒绝信息。

### 人工确认门禁

`confirm` 是第五种节点动作：渲染提示文本后 Run 保持运行并挂起，等待人在控制台从结果边中选择一条后继续。挂起时 daemon 把 Job 标记为 `waiting_input` 并干净退出 worker，应答后以应答模式重启 worker；恢复运行等于重新提问。

#### 验收

- 挂起时 `run.get` 返回 `waiting_input`，节点执行记录带 `pendingInput`（渲染文本与全部结果边名），不消耗模型调用。
- 应答校验等待状态、节点匹配与结果合法性：非法或重复应答被拒绝且不改变等待状态；合法应答按该结果完成节点并继续路由，链式确认天然支持。
- 等待中停止运行正常终止；恢复运行重新渲染提示并再次挂起，旧等待作废。
- confirm 结果说明声明变量表、引用闭包内或并行分支中的 confirm、平台执行器模式携带 confirm 都在启动前拒绝。

### 运行的工作目录

Daemon 的运行配置保存工作区根目录 `workspace`。`run.start` 不带 `cwd` 时，Daemon 在 `<workspace>/<Run ID>` 新建目录作为该 Run 的工作目录并写入 Run 记录；调用方也可以直接给出已存在的目录。两者都没有时拒绝启动并说明去配置工作区根目录。

#### 验收

- 配置里 `workspace` 必须是绝对路径，保存时建目录；留空表示必须为每次运行指定目录。
- 不带 `cwd` 启动时，运行目录为 `<workspace>/<Run ID>` 的真实路径，工作区根目录不存在时自动创建；命令与本地 Pi Agent 在该目录下执行。
- 显式 `cwd` 优先，且必须是已存在的目录，否则返回 `invalid_request`。
- 既无 `cwd` 又无 `workspace` 时返回 `invalid_request`，消息指出可去运行配置填写工作区根目录。
- 同一 Run ID 重试要求 Flow、解析后的工作目录与变量一致；换了工作目录返回 `conflict`，不重复执行。

### 按目录修订启动

Daemon 将固定修订的启动与目录发布串行处理。首次启动核对整个目录的当前修订，把同一修订写入 Run 并从其不可变目录加载 Flow 与子 Flow。普通启动仍使用受理时的当前修订。

#### 验收

- 即使只有其他 Flow 更新，旧修订也返回 `conflict`，不登记 Run、不产生节点历史、不执行命令。
- 同一 ID、Flow、规范化工作目录、变量和修订重试时优先返回原 Run。目录更新、删除 Flow 或 daemon 重启后仍可读取原历史。复用 ID 但绑定不同则返回 `conflict`，不重复执行。
- `flow.list` 只返回标识；`flow.summaries` 一次返回当前修订下每个包的名称、说明、节点数、并行数、变量数与修订。单个包解析失败只在该条带错误原因，不影响其他条目。
- 已发布的包可从 `versions/v1/<Flow ID>/` 读取，`v1` 表示 Flow 规范格式版本。校验通过后才原子切换当前目录。历史修订存放在 `.revisions/<修订>/`，供 Run 固定读取和编辑冲突检查。
- 发布的包包含 `FLOW.md` 和按包内相对路径提供的文本附件。读取包保留文件路径与内容，路径不能越过包根，文件与目录不能重名。保存附件不改变运行时对 `references/` 和 `scripts/` 的资源解析规则。

### 将 Agent 节点交给平台执行

`run.start` 和 `run.startPinned` 可指定 `executorRef: {id, revision}`。引用固定到整个 Run（含子 Flow），参与 Run ID 冲突检查。省略引用使用本地 Pi。命令、变量校验与路由仍由 Runtime 负责。

#### 验收

- 平台模式不需要本地模型 provider。仅支持独立的 `新建Agent` 访问，预检整个引用闭包，拒绝复用会话、本地 Agent 装配能力与包内 references 链接。平台令牌不进入 Run 记录。
- 每次访问先保存新的 `attemptId`，然后 `PUT /api/v2/executor-attempts/{attemptId}`。正文包含 `workInstruction: {text, encoding: "utf-8"}`、固定的 `executorRef` 和 `runConfig.nodeContract: {outcomes, variables}`。这两个数组分别是本节点的结果名与可写变量名。
- 启动回执丢失后只 GET 原尝试。daemon 重启后，`run.resume` 使用原平台和已记录的 ID 核实结果，同一次节点访问不会重复启动。未确认状态不触发路由。
- `run.stop` 通过同一路径的 `/cancel` 发起 POST。未确认停止时返回 `unknown` 并记录取消意图，此后可重试停止，不能恢复路由。
- `succeeded` 后按 `GET /api/v2/directories/{artifactDirectoryId}/file?path=flow-outcome.json` 读取结构化结果。只有 `outcome` 合法且 `variables` 符合所选结果的声明才选边；缺失或非法的结果文件使节点失败。

### Flow Executor MCP stdio adapter

Flow Runtime 通过独立执行器 SDK 为 MCP 客户端提供整条 Flow 的 stdio JSONL adapter，独立于执行器平台。adapter 只暴露 `executor_start`、`executor_inspect`、`executor_cancel`，复用 daemon 的 `run.startPinned`、`run.get` 和 `run.stop`，不复制运行状态机。管理员通过 `URSI_EXECUTOR_ROOT`、`URSI_EXECUTOR_FLOW`、`URSI_EXECUTOR_FLOW_REVISION` 和 `URSI_FLOW_HOME` 固定执行边界。

#### 验收

- 按[执行器 MCP 协议](../docs/EXECUTOR-MCP.md)，`executor_start` 接受小写标准 UUID、与该 ID 绑定的两个目录引用、字符串 `workInstruction` 和可选 JSON 对象 `runConfig`。固定修订的 Flow 适配器未定义运行配置字段，省略或 `{}` 使用部署配置，其他值返回 `invalid`。inspect/cancel 只接受 `{attemptId}`。
- 成功工具结果的 `structuredContent` 与唯一 JSON text 内容相同，包含 `attemptId`、`status`、`artifactDirectoryRef`，并可包含区分后端的 `backendRunRef`；状态只使用 `running`、`succeeded`、`failed`、`cancelled`、`unverified`。
- 工具失败使用 `isError: true`，text 只包含允许的 JSON 错误码 `invalid`、`conflict`、`not_found`、`busy` 或 `unavailable`，不回传路径、凭据或 daemon 原始错误。
- adapter 将 `<URSI_EXECUTOR_ROOT>/<attemptId>/workspace` 作为 cwd，并使用其中的 `artifacts/`；调用 inspect/cancel 前确认真实目录、拒绝符号链接、验证当前用户所有权以及 daemon job 的 ID、Flow、revision、cwd 和任务身份。revision 或部署配置漂移时拒绝操作且不影响其他 Run。
- stdio 生命周期遵循 MCP `initialize`、`notifications/initialized`、`tools/list`、`tools/call`，每个请求一行 JSON，每个响应一行 JSON；解析错误、协议错误和 stdin 关闭都能干净处理。
