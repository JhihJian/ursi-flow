# 从配置包发布 Agent 执行器

配置包保存可编辑的 Agent 配置，执行器修订保存发布时的配置快照。配置人员选择同一个包即可反复试跑、发布；经办人只需选择执行器版本、工作包和本次工作指令。例如，编辑配置包后，即使已经发布 `ticket-review@2`，选择 `ticket-review@1` 仍会使用首版快照。

## 选择 Agent 后端

「平台设置 → Agent 后端」列出管理员登记的运行器、能力和最近的连通性检查。检查只验证控制接口，不调用模型或业务工具。Pi 是内置适配器，其他后端遵循同一[执行器契约](../docs/EXECUTOR-MCP.md)，按[部署说明](server/src/work/agent_backends/README.md)登记。

新建执行器先选配置包。平台从检查通过且支持该包所需能力的后端中匹配，只有一个时自动选择，有多个时由配置人员选择。发布时固定实际后端，运行旧版不会受候选列表或平台重启后检查状态的影响；原绑定被移除或变更时，按版本启动会报错。

## 配置包里维护什么

通过[包接口](server/src/work/patches/HTTP.md)创建配置包后，使用返回的 `directoryId` 在[目录接口](server/src/work/directories/HTTP.md)编辑以下文件。界面可复用[配置包编辑器](PATCH-STUDIO.md)。

| 文件 | 用途 |
| --- | --- |
| `AGENTS.md` | 固定指令，作为 Pi 的系统上下文。 |
| `skills/<id>/SKILL.md` | 该 Skill 的正文，随固定指令进入系统上下文。 |
| `mcp.json` | 按管理员策略选择受管模型和只读业务工具。 |

例如，`mcp.json` 可以写成：

```json
{"mcpServers": {}, "modelProfile": "review-v1", "tools": ["tickets.get"]}
```

`modelProfile` 和 `tools` 都是顶层可选字段。省略 `modelProfile` 时取管理员策略 `models` 列表中的第一项；省略 `tools` 时业务工具列表为空，Pi 仍可读取工作材料。`tools` 的元素是策略中的工具 ID 字符串。`mcpServers` 只支持空对象，业务服务地址、模型连接参数和凭据由管理员提供。

## 何时读取配置

发布和试跑使用同一种执行器定义。`configPackageId` 填配置包记录的 `id`，`directoryId` 只用于文件读写。

```json
{"id": "ticket-review", "agent": {"configPackageId": "配置包 ID", "backendId": "pi"}}
```

| 操作 | 配置来源和结果 |
| --- | --- |
| 草稿试跑 | 向 `PUT /api/v2/executor-attempts/{attemptId}` 提交 `previewDefinition`，其值为上例定义。Server 读取包的当前内容并固定本次尝试的快照和后端。试跑不占用执行器修订号。 |
| 发布修订 | 向 `POST /api/v2/executors` 提交上例定义。Server 解析配置包，校验模型和工具授权，将公开修订、私有快照和后端绑定一起保存。快照含固定指令、Skill 正文、模型配置 ID、工具 ID 和参数 schema 摘要。 |
| 按版本运行 | 在尝试请求中指定 `executorRef: {"id":"ticket-review","revision":1}`。Server 按该修订读取快照。工作包的 `configPackage: {id}` 不参与执行器配置解析，即使它指向另一份有效配置包。 |

## 运行和重试

试跑和按版本运行都将 `workPatchId` 指定的工作包文件放入 `inputs/`。Pi 为每次尝试创建隔离会话，把固定指令和 Skill 放入系统上下文，将 `workInstruction` 单独作为用户消息。成功后，Workbench 将报告发布到只读制品目录。业务工具调用时仍须核验当前授权和快照内的 schema 摘要。

Workbench 按[执行器协议](../docs/EXECUTOR-MCP.md)将启动、查询和取消路由到该尝试绑定的运行器。相同 `attemptId` 和参数复用原尝试，更换修订或指令返回 409。启动回执丢失后可按 ID 查询；已经发出但无法核实的模型请求标记为 `unverified`，不自动重发。

## 版本隔离验收

[Pi 端到端用例](server/tests/pi_executor_e2e.py)先发布 `ticket-review@1`，再编辑原包的三个文件，以同一个定义试跑并发布 `@2`。工作包始终提供同一份工单，另引用一份带不同固定指令和 Skill 的配置包。

验收以本机模型服务收到的请求为准：新启动的 `@1` 应收到首版固定指令和 Skill、显式指定的模型和工具；新试跑和 `@2` 应收到修改后的正文，并在省略模型和工具选项时使用策略首个模型、只保留材料读取工具。三次尝试的系统消息都应排除工作包所引用配置的指令和 Skill，同时 `read_input` 都应读到该工作包里的工单。
