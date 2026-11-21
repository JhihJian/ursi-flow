# Workbench 执行器接入

Workbench 作为[执行器 MCP 协议](../docs/EXECUTOR-MCP.md)的调用方，接收 HTTP 请求，准备本次尝试的工作区，并在执行器报告终态后发布只读制品。它使用 Rust MCP SDK `rmcp` 启动本机 stdio 会话，丢弃 stderr。Flow 和 Agent 后端共用同一协议。

## 部署与目录

管理员通过 `URSI_EXECUTOR_BIN` 指定受信 Flow 适配器的绝对路径，Agent 尝试使用服务端登记的适配器。Workbench 无参数启动适配器。HTTP 调用方不能指定命令、环境变量、Flow 或宿主路径。执行入口独立于[平台 MCP 服务](server/src/work/mcp/PLATFORM.md)。

客户端清空继承环境，仅为子进程设置以下变量。`URSI_API_TOKEN` 等父进程凭据不传给执行器。

| 子进程变量 | 值或来源 |
| --- | --- |
| `PATH` | 固定为 `/usr/local/bin:/usr/bin:/bin` |
| `URSI_EXECUTOR_ROOT` | Workbench 提供的私有尝试根目录 |
| `URSI_EXECUTOR_FLOW`、`URSI_EXECUTOR_FLOW_REVISION`、`URSI_FLOW_HOME` | 仅 Flow 调用且服务环境已设置时放行，指定 Flow ID、固定目录修订和 daemon 目录 |
| `URSI_PI_POLICY` | 仅 Agent 适配器接收，与注册条目绑定的私有策略绝对路径 |

Workbench 把工作包材料复制到本次尝试的 `inputs/`。未指定工作包时，输入目录为空。收集时只读取 `artifacts/`。复制材料和收集制品均只接受目录和无硬链接的普通文件，拒绝符号链接和特殊文件。每次复制最多 4096 个条目、32 层、单文件 8 MiB、合计 64 MiB。

## HTTP 调用与制品发布

以下路径均在 `/api/v2` 下，需要 `Authorization: Bearer <URSI_API_TOKEN>`。HTTP 调用方先生成并保存小写 UUID；即使未收到首次 HTTP 回执，也能用这个 ID 查询。

| 方法与路径 | 请求与语义 |
| --- | --- |
| `PUT /executor-attempts/{attemptId}` | JSON 如 `{"workInstruction":{"text":"检查材料并写出 report.txt","encoding":"utf-8"},"workPatchId":"包标识"}`。指令正文必须非空且不超过 256 KiB，`workPatchId` 是可选字符串。首次冻结输入并启动；同 ID、同参数查回原尝试，必要时可用相同 PUT 显式重发同 ID 的幂等启动。更换指令或工作包返回 409。 |
| `GET /executor-attempts/{attemptId}` | 读取原尝试，按需查询后端并收集制品。启动回执丢失、状态为 `starting`、`running` 或 `unverified` 时，继续用 GET 核对，不触发启动。 |
| `POST /executor-attempts/{attemptId}/cancel` | 无需正文。请求取消原尝试，以返回或后续查询确认的状态为准。 |

HTTP 指令保留 `{text, encoding}` 形状，Workbench 将 `text` 作为 MCP 字符串发送。PUT 可另带 JSON 对象 `runConfig`。服务端按尝试冻结并转发非空配置，省略与 `{}` 等价，同一 ID 改动配置返回 409。具体可用字段由目标执行器定义。

Agent 启动请求在原正文上二选一：`executorRef: {id,revision}` 使用修订的冻结快照和后端；`previewDefinition: {id,agent:{configPackageId,backendId?}}` 解析配置包并在服务端选择就绪且兼容的后端。`backendId` 省略时须恰有一个候选。Agent 尝试返回服务器选定的 `backendId`；程序路径和策略路径存于私有绑定。查询、取消、重复 PUT 均核对原绑定，后端移除或路径改变返回 503。SDK 的 `agent-config.json` 和 MCP 工具参数均不包含 `backendId` 或部署路径。

HTTP 尝试记录中的 `artifactDirectoryRef` 从启动起就能标识输出位置。**只有确认终态并收集了 `artifacts/` 后，才发布只读 `artifactDirectoryId`。** 收到 ID 后用 `GET /api/v2/directories/{artifactDirectoryId}/tree` 列文件，用同目录的 `/file?path=report.txt` 取原始字节；写入返回 409。轮询和收集按请求推进。

实现与验收：[stdio 客户端](server/src/work/executor/client.rs)、[Flow 执行器设计](../docs/design/workbench/FLOW-EXECUTOR-DESIGN.md)、[Agent 执行器设计](../docs/design/workbench/PI-AGENT-EXECUTOR-DESIGN.md)、[HTTP 端到端用例](server/tests/executor_mcp_e2e.py)。
