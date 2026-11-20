# Flow Runtime 作为 Workbench 执行器

Workbench 持有尝试记录、输入和发布后的制品；`ursi-flowd` 持有 Flow 包修订、Run 和节点历史。两边共用 `attemptId`。本机适配器 `ursi-flow-executor-mcp` 在两者之间转换[执行器 MCP 协议](EXECUTOR-MCP.md)与 daemon 的 Unix socket 请求。首版由管理员固定一个适配器和一个 Flow 修订，独立于执行器定义目录、只读 MCP 资源注册表和 v1 Flow 管理接口。

## 绑定一个 Flow

管理员先在目标 daemon 发布 Flow 包，取得发布结果的 `revision`。Flow 声明文本变量 `任务`，可在节点中使用 `{var.任务}`。给 Workbench 服务设置：

| 服务环境变量 | 含义 |
| --- | --- |
| `URSI_EXECUTOR_BIN` | 已安装的 `ursi-flow-executor-mcp` 可执行文件的绝对路径，或管理员控制的可执行包装脚本 |
| `URSI_EXECUTOR_FLOW` | daemon 中已发布的 Flow ID |
| `URSI_EXECUTOR_FLOW_REVISION` | 发布时返回的目录修订。新 Run 通过 `run.startPinned` 核对当前目录修订 |
| `URSI_FLOW_HOME` | 目标 daemon 的绝对目录；适配器连接其中的 `runtime.sock` |

Workbench 另向适配器提供 `URSI_EXECUTOR_ROOT`，子进程环境放行清单见[部署契约](EXECUTOR-MCP.md#部署与目录)。适配器只连接 daemon。使用外置 `ursi-flowd` 时可以设置 `URSI_FLOW_ENABLED=0` 关闭 Workbench 自管的 daemon；这与启用执行器是两个开关。

## 一次尝试如何执行

以生成 `report.txt` 的命令节点为例：

1. HTTP 调用方选定小写 UUID，用 `PUT /api/v2/executor-attempts/{attemptId}` 提交 UTF-8 工作指令和可选的 `workPatchId`。Workbench 按尝试准备 `<root>/<attemptId>/workspace`，材料放在 `inputs/`，结果写到独立的 `artifacts/`。
2. Workbench 在新的 stdio 会话调用 `executor_start`。适配器校验 ID 和目录引用，确认使用的目录归当前用户所有且不经符号链接，再调用 `run.startPinned`。Run 的 `id` 就是 `attemptId`，`cwd` 是该 workspace，变量恰为 `{"任务": workInstruction.text}`，Flow 和修订来自管理员配置。启动返回时核对这组参数；同 ID、同参数沿用原 Run。
3. Flow 在工作目录写出 `artifacts/report.txt`。调用方按需 GET 原尝试；需要查询时，Workbench 另开会话调用 `executor_inspect`。适配器通过 `run.get` 核对 Run ID、Flow、修订和工作目录，返回状态及 `backendRunRef: "flow:<attemptId>"`。节点过程可由 CLI 用同一 ID 查 `run history`。
4. daemon 的 `running`、`completed`、`failed`、`stopped` 分别映射到 `running`、`succeeded`、`failed`、`cancelled`，其他状态映射到 `unverified`。Workbench 仅在确认终态后从 `artifacts/` 收集结果，发布冻结的虚拟目录。调用方用 `artifactDirectoryId` 查目录树并读取 `report.txt`，输入材料不在其中。

## 回执丢失与取消

- **回执丢失：** 即使 stdio 进程在回复前退出，daemon 中的 Run 也可能已经执行。先 GET 原 ID 核对；重启 Workbench 后也用原 ID 查询。GET 不启动 Run。同参数 PUT 可以查回，或显式按原 ID 幂等重发启动。换指令或换工作包要用新 ID。
- **身份或状态待核实：** 适配器拒绝把 Flow、修订或工作目录不匹配的 Run 当成这次尝试。`unverified` 不是终态，此时不发布制品目录，可以继续 GET。
- **取消：** `POST /api/v2/executor-attempts/{attemptId}/cancel` 对应 `executor_cancel`。适配器先 `run.get` 核对身份，再 `run.stop` 并检查返回的 Run。取消与完成竞争时，以实际状态为准。

[端到端用例](server/tests/executor_mcp_e2e.py)含可运行的命令型 Flow、构建命令和部署环境示例。它让节点记录执行次数并写出报告，检查同 ID 重复 PUT 只执行一次、丢弃启动回执后仅用 GET 找回报告、终态目录拒绝写入，以及鉴权、取消和未配置执行器时的行为。
