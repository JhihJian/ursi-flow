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

发布时，目录检查 `inputs`、`outputs` 的名称和类型兼容性，合并包、动作与执行器引用的 `resources`。执行时使用工作项快照中的 `actions[action].executor`（固定版本的投影）和同级 `resources`（已展开的正文），不再解析发布请求中的引用或端口声明。

本地 Agent 需要管理员配置 `URSI_AGENT_BIN` 为支持这些选项的 Pi 可执行文件绝对路径。Pi 在管理员指定的工作目录内，以 `--print --mode text --no-session` 运行，从标准输入接收动作、SOP、固定版本的 prompt/skill 正文和工作项输入。其余参数是 `--no-tools --no-extensions --no-mcp --no-skills --no-prompt-templates --no-context-files --no-approve`。尝试中的 `workspace` 为 `default`；后端输出内的实际目录文本替换为 `[workspace]`。部署者提供 Pi 模型和认证配置；子进程环境按名称放行，不继承 `URSI_API_TOKEN`。Agent 输入上限 256 KiB，stdout 和 stderr 各 64 KiB，单次最长 5 分钟，同时最多 4 个 Agent。超时、超限、取消和正常退出均清理本次 Unix 进程组。这是受信本地执行，不是沙箱。服务异常退出后不使用持久化 PID 杀进程。

显式指定 `environment:"sandbox"` 的 Agent 使用独占的 ACP 沙箱。`starting` 时 `backendRunId` 为空，登记会话后它是真实 sessionId，`workspace` 是环境别名。配置、收尾和可选真实会话验收见 [预配 ACP 沙箱](SANDBOX.md)。

Flow 仅支持固定 `flowId`、`flowRevision` 且 `resources` 为空的绑定。工作项 `input` 对象原样作为 Flow 变量。尝试 ID 就是 daemon run ID；详情与历史可经同一 daemon 的 CLI 查询。相同尝试只调用一次 `start_pinned`，并发 SDK 调用最多 8 个。Flow 修订冲突返回 409，记录失败尝试，不回退到无修订启动。

`starting` 表示等待 daemon 受理。`running` 表示本地执行已交给 Agent 任务，或 daemon 报告运行中。`succeeded`、`failed`、`cancelled` 是确认的尝试结果。`unverified` 表示缺少完成证据，可能已有副作用。重启恢复只标记未结束尝试，重新查询 Flow 可取得 daemon 的后续证据。收到错误或断线时先查列表和详情；显式重新提交会创建独立的新尝试。

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
