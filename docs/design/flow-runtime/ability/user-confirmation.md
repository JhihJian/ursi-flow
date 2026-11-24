# 用户确认门禁节点

## 背景与目标

Flow 的判断目前只有两种来源：Agent 节点由运行中的模型提交结果，命令节点固定提交`已执行`。部署、发布、删除资源这类敏感操作缺少第三种判断：由人评审后选择结果。

本设计新增 confirm 类型节点：运行到该节点时挂起，控制台向人展示待评审内容与全部可选结果，人选一条结果边后流程继续。它是"由人选边"的节点——与 Agent 节点唯一的差别是提交`result`的从模型换成了人。

## 关键决定

1. **不需要声明交互内容，从出边逆推。** 节点有哪些结果边，人就有哪些选项；每条结果边的三级标题与说明就是选项的展示文案。待评审内容由动作区代码块的文本渲染而成。除动作文本外没有任何声明，不引入 JSON 对象、表单 Schema 或字段类型。
2. **confirm 节点只选边，不收集变量。** 结果说明是纯文本描述，不允许变量表。需要向下游传递数据时，由确认前的 Agent 或命令节点产出。
3. **挂起即 worker 干净退出，应答即重启 worker。** 运行到 confirm 节点时 worker 以 awaiting 标记退出，daemon 把 Job 置为`waiting_input`；`run.respond`记录选择后以应答模式重启 worker 续跑。daemon 重启后仍可作答。
4. **恢复等于重新提问。** 未决确认的 Run 执行`run.resume`时，worker 重新执行确认节点、重新渲染待评审文本并再次挂起，旧等待作废。
5. **平台执行器模式与子 Flow 引用闭包暂不支持**，启动预检直接拒绝。

## Flow 文件格式

动作代码块标记为`confirm`，内容是纯文本待评审说明，支持`{var.xxx}`与`{input.xxx}`模板引用；结果边与普通 Agent 节点写法完全一致：

```markdown
## 确认发布

```confirm
即将发布 {var.项目} 到生产环境：
- 版本：{var.版本}
- 变更摘要：{input.变更摘要}

请评审以上内容并选择处理方式。
```

### 通过

内容符合预期，批准发布。

### 驳回

存在风险，退回修改。
```

图中写`approve[确认发布] -->|通过| deploy[执行发布]`等结果边。一条结果边也是合法的（阅读确认后继续的"已知悉"型门禁）。

解释器新增检查：动作标记`confirm`、代码块为非空文本（参与模板校验，规则与 Agent 提示词一致）；出边规则与 Agent 节点相同（每条出边带结果名并有非空三级说明），但结果说明中不允许变量表。并行分支与汇合只允许命令节点，confirm 节点天然被拒。

## 运行时行为

1. **等待。** Runtime 渲染待评审文本，创建 NodeRun，把渲染后的说明与选项列表（结果名 + 三级说明）记入该记录的`pendingInput`，Run 进入新阶段`awaiting_input`，发出观察事件`run.awaiting_input`；worker 以 awaiting 标记干净退出，daemon 把 Job 置为`waiting_input`。等待中的 Run 仍是 running 状态，不是终态。
2. **应答。** 控制台调用`run.respond {id, nodeRunId, result}`。Runtime 校验`result`是该节点声明的结果名，然后按该结果完成节点并路由。`run.respond`只在`waiting_input`状态接受，`nodeRunId`必须匹配当前未决节点；重复作答或非法结果名一律拒绝且保持等待。放弃整个运行使用既有的`run.stop`，等待状态下同样有效。
3. **恢复。** daemon 重启后`run.resume`放行本地`waiting_input`的 Run，重新提问再次挂起；已作答但 worker 中断的极端情况下，应答已写入 job.json，续跑时仍被消费。

daemon 经 0700 目录下的 Unix socket 服务，应答与现有操作共享同一本机信任边界，不新增认证。

## 模块改动

| 模块 | 改动 |
| --- | --- |
| `core/contracts/types.ts` | `FlowAction`增加`ConfirmAction { kind: "confirm"; prompt: string }`；`RunPhase`增加`awaiting_input`；`NodeRunRecord`增加可选`pendingInput { message, options }`；观察事件增加`run.awaiting_input` |
| `core/definition/parser.ts` | 动作解析新增`confirm`分支（纯文本 + 模板校验）；图校验沿用 Agent 出边规则并禁止结果变量表 |
| `core/execution/runtime.ts` | 动作分发新增 confirm 分支（渲染、记 pending、进入等待）；新增公开`respond(runId, nodeRunId, result)`；挂起经 sentinel 异常干净返回 |
| `core/execution/preflight.ts` | 平台执行器模式与引用闭包内 confirm 节点的预检拒绝 |
| `machine/worker.ts` | 捕获等待 sentinel：发 awaiting 标记并干净退出；新增应答模式（读 job.json 选择 → `runner.respond` → 续跑） |
| `machine/runs.ts` | Job 状态`waiting_input`；close 推导优先采纳 awaiting 标记；新增`respond`（校验、写 job.json、重启 worker）；`resume`放行本地`waiting_input` |
| `machine/daemon.ts` | 新操作`run.respond` |
| `web` | 轮询条件纳入`waiting_input`；详情页增加待确认卡片：渲染待评审文本、按`pendingInput.options`展示选项按钮，点选即 respond；新增 respond API 透传 |
| 文档 | `flow-spec.md`新增 confirm 动作与解释器检查；本设计登记进架构索引 |

测试沿用现有布局：解析与运行时用 vitest，daemon 与 worker 全链路用 node:test（仿`local-pi.test.mjs`）。

## 非目标与演进

- **结果变量收集**：confirm 节点固定不传值；确有需要时再按 ACP form 模式立项。
- **URL 模式**（OAuth 等带外交互）与**能力协商**：不进入本设计。
- **Agent 主动询问用户**（经 Agent 会话发起的 elicitation）：属于 Agent 宿主扩展，与本门禁正交。
- **子 Flow 与平台模式支持**：待应答目标定位与平台协议明确后放开。

## 验收标准

1. 含 confirm 节点的 Flow 运行至该节点时挂起：`run.get`返回`awaiting_input`，节点记录携带渲染后的`pendingInput`（说明与全部选项），worker 已退出且不占并发额度。
2. `run.respond`提交合法结果名：节点完成，流程沿该结果边继续到终态。
3. `run.respond`提交未声明的结果名、重复作答、对非等待 Run 或错误`nodeRunId`作答：一律拒绝且保持等待。
4. daemon 重启后`resume`重新提问并再次挂起；重启后`respond`仍可完成应答并续跑。
5. 预检：结果说明携带变量表、并行分支中的 confirm 节点、引用闭包内 confirm 节点、平台模式携带 confirm 节点，均在运行前拒绝。
6. 等待状态下`run.stop`正常终止；取消后的 Run 不可`respond`。
7. 控制台在等待期间持续轮询，待确认卡片展示待评审文本与全部选项，点选后流程继续。
