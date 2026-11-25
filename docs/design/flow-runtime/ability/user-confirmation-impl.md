# 用户确认门禁实现改动

依据[用户确认门禁节点](user-confirmation.md)。核心实现约束：daemon 与 worker 之间只有一次性启动 IPC，没有双向请求通道；挂起与应答都复用"worker 干净退出、daemon 重启 worker 续跑"的既有模型，不引入长驻等待进程。

## 契约与解析

| 文件 | 改动 |
| --- | --- |
| `core/contracts/types.ts` | `FlowAction`增加`ConfirmAction { kind: "confirm"; prompt: string }`；`RunPhase`增加`awaiting_input`；`NodeRunRecord`增加可选`pendingInput { message, options }`；观察事件类型增加`run.awaiting_input` |
| `core/contracts/extensions.ts` | 新增等待 sentinel 错误类（仿`AttemptUnconfirmed`），Runtime 内部表达"节点进入等待" |
| `core/definition/parser.ts` | `parseAction`新增`confirm`分支：代码块为非空纯文本，参与模板校验；`validateAndWireGraph`沿用 Agent 出边规则并新增检查：confirm 节点的结果说明不允许变量表 |
| `core/execution/preflight.ts` | 平台执行器模式与引用闭包内出现 confirm 节点时预检拒绝 |

## 运行时挂起与应答

`core/execution/runtime.ts`：

- 动作分发新增 confirm 分支：渲染`prompt`，创建 NodeRun（无 session），把`pendingInput`随提交写入，Run 进入`awaiting_input`并发观察事件，然后抛出等待 sentinel。
- `continueRun`的异常出口捕获等待 sentinel：正常返回当前 Run 快照（`finally`中既有的 Agent 绑定释放照常执行），不判失败。
- 新增公开方法`respond(runId, nodeRunId, result)`：校验等待事实与`nodeRunId`匹配、`result`属于该节点结果集合，然后按"从已完成节点续接"路径以该结果完成节点并路由；途中再遇 confirm 节点则再次挂起，链式确认天然支持。
- 节点执行与子 Flow 的异常边界放行等待 sentinel，不把挂起误判为失败（引用闭包内的 confirm 节点已被预检拒绝，本期无需跨 Run 传播）。

## daemon 与 worker

| 文件 | 改动 |
| --- | --- |
| `machine/worker.ts` | 消息处理新增应答模式：读取 job.json 中的应答调用`runner.respond`续跑；捕获等待 sentinel 后发送 awaiting 标记并干净退出 |
| `machine/runs.ts` | Job 新增状态`waiting_input`：`child.on("message")`扩展接收 awaiting 标记，close 推导优先采纳（现有逻辑会把干净退出判为`unknown`）；新增`respond`：校验 Job 处于`waiting_input`，应答写入 job.json 后以应答模式重启 worker；`resume`放行本地`waiting_input` |
| `machine/daemon.ts` | `dispatch`新增操作`run.respond {id, nodeRunId, result}` |

应答只经 daemon 校验后交给 worker 内的引擎，等待事实与应答记录都在过程日志里；daemon 不直接写运行事实。重复 respond 因快照已离开等待状态而拒绝，daemon 串行队列内不再额外加锁。

## 控制台

- `web/server.mjs`：新增`POST /api/v1/runs/:id/respond`，透传 daemon `run.respond`。
- `web/src/data.ts`：`NodeRun`视图增加`pendingInput`，source 增加`respond`。
- `web/src/Runs.tsx`：轮询条件纳入`waiting_input`（现有轮询挂在`running`上，挂起后会停）；详情页新增待确认卡片：渲染待评审文本，按`pendingInput.options`展示选项按钮，点选即 respond。
- `web/src/main.tsx`：状态标签补`waiting_input`。

## 测试与落地顺序

测试沿用现有布局：解析与运行时用 vitest（`test/parser.test.ts`、`test/runtime.test.ts`，复用 helpers 的测试协调器与假 Adapter），daemon 与 worker 全链路用 node:test（仿`local-pi.test.mjs`）。

1. **契约与解析**：类型、解析、图校验用例；`npm run typecheck`。
2. **运行时挂起与应答**：跑到`awaiting_input`、合法与非法 respond、沿结果边路由到终态、恢复重新提问。
3. **daemon 与 worker**：启动含 confirm 的 Flow 到挂起、respond 续跑到终态、daemon 重启后 resume 与 respond、重复 respond 拒绝、等待中 stop。
4. **控制台**：手工验证轮询、卡片渲染与提交；沿用 web e2e 基建补充用例。
