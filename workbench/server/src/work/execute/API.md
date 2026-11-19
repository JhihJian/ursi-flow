# 工作项执行尝试

仅 `working` 工作项可发起执行。请求体只含 `action`，动作、执行器、SOP 和资源来自该工作项的发布快照。成功返回尝试对象，执行结束后工作项仍是 `working`。

以下示例假设路由挂在 `/api`，工作项 `$ITEM` 已开始办理，包内定义 `analyze` 动作。

```bash
BASE="${SERVER:-http://localhost:8080}/api/v2/items/$ITEM/attempts"
AUTH="Authorization: Bearer $URSI_API_TOKEN"
# 创建一次新尝试，请勿为此 POST 配置自动重试。
ATTEMPT=$(curl -fsS -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"action":"analyze"}' "$BASE" | jq -er '.id')
curl -fsS -H "$AUTH" "$BASE/$ATTEMPT" | jq '{id,status,output}'
# 丢失创建响应时先查本单历史。列表是持久化的最近观测，Flow 单项查询刷新 daemon 状态。
curl -fsS -H "$AUTH" "$BASE" | jq '.[] | {id,action,status}'
# 停止这一次尝试。终态保持原值，包括取消时恰好已完成的情况。
curl -fsS -H "$AUTH" -X POST "$BASE/$ATTEMPT/cancel"
```

发布时，目录检查包和动作 `inputs`、`outputs` 的名称与类型格式，合并包、动作与执行器引用的 `resources`。执行器不声明业务端口。执行时使用工作项快照中的 `actions[action].executor`（固定版本的投影）和同级 `resources`（已展开的正文），不再解析发布请求中的引用或端口声明。

如果工作项快照动作带有 `configPackage`，创建尝试时会先读取并校验配置包，再在独立目录事务中创建本次尝试的快照。冻结结果只保存配置 `version`、普通 `values`、secret 的状态、`sourceRef` 和本次尝试新生成的 `snapshotRef`。secret 的值、provider locator 和配置目录路径不会写入尝试；带值的 secret 只记录 `{"state":"irreversible"}`，内部引用只记录 `{"state":"internalRef"}`。没有配置的旧结构使用空 values、空 secrets 和空 sourceRef。

配置包交给执行器时使用尝试专属的冻结目录能力引用：`{"id":"<snapshot-directory>","access":"read-only","purpose":"executor-config"}`。该引用与 `snapshotRef` 均按尝试生成，重试不会复用。公开的尝试响应只携带能力引用，不携带 `cwd` 或任何宿主绝对路径。当前本地 Agent 适配器在受信进程边界内把冻结目录映射到 `URSI_CONFIG_DIR`，这是适配器私有实现细节，执行器定义和工作指令均不携带宿主路径。

本地 Agent 需要管理员配置 `URSI_AGENT_BIN` 为支持这些选项的 Pi 可执行文件绝对路径。Pi 在管理员指定的工作目录内，以 `--print --mode text --no-session` 运行，从标准输入接收冻结的 `workInstruction`（动作、SOP、固定版本的 prompt/skill 正文和工作项输入）。其余参数是 `--no-tools --no-extensions --no-mcp --no-skills --no-prompt-templates --no-context-files --no-approve`。平台通过 `URSI_ARTIFACT_DIR` 提供制品目录能力，并在存在配置包时通过适配器私有的 `URSI_CONFIG_DIR` 提供只读配置目录；这些变量与工作目录一样不随尝试返回。当前内置 Pi 调用关闭工具和扩展，因此实际写入需要后续执行器能力或受控包装程序；本切片负责目录登记、配置包快照、清单和终态冻结。尝试中的 `workspace` 是 `{"id":"default","access":"read-write","purpose":"work-input"}` 引用；后端输出内的实际目录文本分别替换为 `[workspace]` 和 `[artifacts]`。部署者提供 Pi 模型和认证配置；子进程环境按名称放行，不继承 `URSI_API_TOKEN`。Agent 输入上限 256 KiB，stdout 和 stderr 各 64 KiB，单次最长 5 分钟，本地 Agent 集成默认最多 4 个并发 lease。超时、超限、取消和正常退出均清理本次 Unix 进程组。这是受信本地执行，不是沙箱。服务异常退出后不使用持久化 PID 杀进程。

### 尝试对象与制品目录

尝试除了 `id`、`itemId`、`action`、`status`、`executor`、`executorIntegration`、`resources`、`backendRunId` 和旧 `output` 外，还包含：

| 字段 | 含义 |
| --- | --- |
| `workspace` | `{id, access, purpose}` 目录能力引用。本地与 Flow 的 `id` 为 `default`，沙箱为环境别名。 |
| `workInstruction` | 启动时冻结的 `{text, encoding}`。Flow 的 `text` 是工作项输入 JSON。 |
| `artifactDirectory` | 本次尝试独占的 `{id, state}`，`state` 为 `writable` 或 `frozen`。 |
| `platformLog` | 平台记录日志数组，每条含 `sequence`、`occurredAt`（Unix 秒）、`source`、`event`、`message`、`attemptStatus`。 |
| `executorIntegration` | 平台选中的内部集成不透明引用 `{id, revision}`。它不包含实现路径、命令、工作目录、环境变量或凭据；尝试创建后不重新选择。 |
| `executorLog` | 执行器记录日志，当前为 `{source, kind:"text", entries:[{sequence, occurredAt, stream, text}]}`，未产生时为 `null`。 |
| `executorLogPage` | 执行器自建静态日志页入口，当前恒为 `null`，平台不生成地址。 |
| `configPackage` | 尝试创建时冻结的配置 `{version,values,secrets,sourceRef,snapshotRef,capability}`。secret 仅保留状态，能力引用不是宿主路径。 |
| `recoveryNotice` | 重启恢复提示，与执行器 `output` 分开保存。 |

制品文件清单读 `GET /api/v2/directories/{artifactDirectory.id}/tree`，返回 `{path,kind,size?}` 数组。尝试进入终态（含 `unverified`）时平台冻结目录：此后对该目录的 `PUT`、`/dir`、`/move` 和 `DELETE` 均返回 409，`GET` 与 `tree` 不变。重试创建新的尝试并获得新目录，旧目录保持可读。

旧数据迁移：旧的 `workspace` 字符串（别名或宿主路径）在服务启动时改为上述引用，宿主路径同时从 `output` 中剔除；此前由当前本地 Agent 创建且没有旧后端字段的尝试补为 `executorIntegration: {id:"local-agent",revision:1}`；旧 Flow/Sandbox 字段不会补造集成。缺失的 `workInstruction`、`artifactDirectory`、`executorLog`、`executorLogPage`、`configPackage` 补为 `null`，`platformLog` 补为空数组。重启前的未结束尝试仍转为 `unverified`，但恢复提示只写 `recoveryNotice` 和平台日志，不再覆盖 `output`。

当前执行入口只接受目录发布的通用执行器投影，并通过内部集成注册表选择本地 Agent 适配器。只有新尝试参与选择。没有匹配且就绪的集成或容量已满时返回 503，不创建配置快照、制品目录或尝试。已登记尝试的集成引用保持不变；如果该修订后来没有注册，历史列表仍可读取，单次查询、取消和核实返回 503。带旧 `kind`、`environment`、`flowId` 或 `flowRevision` 的历史快照不会启动；查询、取消和人工核实返回 503，不会重放旧后端。沙箱和 Flow 的迁移说明保留在 [预配 ACP 沙箱](SANDBOX.md) 及历史设计文档中，当前不属于可用执行后端。

`starting` 表示等待 daemon 受理。`running` 表示本地执行已交给 Agent 任务，或 daemon 报告运行中。`succeeded`、`failed`、`cancelled` 是确认的尝试结果。`unverified` 表示缺少完成证据，可能已有副作用。重启恢复只标记未结束尝试，重新查询 Flow 可取得 daemon 的后续证据。收到错误或断线时先查列表和详情；显式重新提交会创建独立的新尝试和新制品目录。

本次迁移未包含的部分：端口声明与 `output` 文本仍并存，交付仍提交文本文件对象而不是从制品目录选择，Flow 的执行器日志和人工自定义日志页未接入。

### 人工核实待核实的尝试

先确认进程已经结束并检查可能的副作用。仅在证据支持失败或取消时，向 `POST /api/v2/items/{id}/attempts/{attempt}/verify` 提交结论。例如：

```bash
curl -fsS -H "$AUTH" --json '{"status":"failed","evidence":"审计记录 #42 显示进程异常退出，报告未生成","reason":"无法交付该次执行的报告"}' "$BASE/$ATTEMPT/verify"
```

`status` 只接受 `failed` 或 `cancelled`，`evidence`、`reason` 各为不超过 4096 字节的非空文本。非 `unverified` 尝试返回 409。成功响应保留原 `output`；`verification.previousStatus` 为 `unverified`，`verification` 同时记录人工结论、证据及原因。若由重启恢复，`interruptedStatus` 记录中断前状态。核实不发送执行或取消命令，也不生成成功输出。再次核实不能覆盖记录。没有其他未结束或待核实尝试时，经办人可另行提交交付。

**Flow 的核实依据。** 每次提交核实，Server 都用原绑定的 `backendRunId`（必须等于尝试 ID）调用一次 `run.get`。详情页上次显示的 `unknown` 不能代替这次查询。

| 本次查询结果 | 核实结果 |
| --- | --- |
| run ID、Flow ID 和固定修订均匹配，状态为 `unknown` | 可记录人工结论。`unknown` 本身不证明进程已停止或没有副作用。 |
| 配置的 daemon 对该 ID 返回协议业务码 `not_found` | 可记录人工结论。此证据只说明 daemon 查不到该 run。 |
| 绑定匹配，状态为 `running`、`completed`、`failed` 或 `stopped` | 按 daemon 报告刷新尝试，人工核实返回 409。 |
| 响应绑定不符、状态无法识别、超时、不可达或仅有 404 错误文本 | 保留 `unverified`，稍后重新核实。 |

人工核实成功时，`verification.daemonEvidence` 记录查询操作、run ID、原绑定的 Flow ID 和修订，以及 `result`（`unknown` 或 `not_found`）。人工证据及原因另存于 `verification.evidence` 和 `verification.reason`。
