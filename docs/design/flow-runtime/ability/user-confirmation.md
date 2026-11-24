# 用户确认门禁节点

## 背景与目标

Flow 的判断目前只有两种来源：Agent 节点由运行中的模型提交结果，命令节点固定提交`已执行`。部署、发布、删除资源这类敏感操作缺少第三种判断：由人评审后选择结果。

本设计新增 confirm 类型节点：运行到该节点时挂起，控制台向人展示待评审内容与全部可选结果，人选一条结果边后流程继续。它是"由人选边"的节点——与 Agent 节点唯一的差别是提交`result`的从模型换成了人。交互契约取 [ACP v2 Elicitation](https://agentclientprotocol.com/protocol/v2/elicitation) 的门禁子集：展示待评审内容、提供明确的选择入口、服务端校验提交的选择。

## 关键决定

1. **不需要声明交互内容，从出边逆推。** 节点有哪些结果边，人就有哪些选项；每条结果边的三级标题与说明就是选项的展示文案。待评审内容由动作区代码块的文本渲染而成。除动作文本外没有任何声明，不引入 JSON 对象、表单 Schema 或字段类型。
2. **confirm 节点只选边，不收集变量。** 结果说明是纯文本描述，不允许变量表。需要向下游传递数据时，由确认前的 Agent 或命令节点产出。
3. **等待状态持久化，应答经 daemon 继续。** 等待事实随 Run 记录落盘，Run 进入`awaiting_input`阶段；人在控制台作答，daemon 记录选择后流程继续。挂起的进程承载方式是实现策略，见[实现改动](user-confirmation-impl.md)。
4. **恢复等于重新提问。** 未决确认的 Run 执行`run.resume`时重新渲染待评审文本并再次挂起，旧等待作废。
5. **平台执行器模式与子 Flow 引用闭包暂不支持**，启动预检直接拒绝。

## 运行时行为

1. **等待。** Runtime 渲染待评审文本，创建 NodeRun，把渲染后的说明与选项列表（结果名 + 三级说明）记入该记录的`pendingInput`，Run 进入`awaiting_input`阶段并发观察事件。等待中的 Run 仍是 running 状态，不是终态；等待事实已持久化，daemon 重启不丢失。
2. **应答。** 控制台调用`run.respond {id, nodeRunId, result}`。Runtime 校验`result`是该节点声明的结果名，然后按该结果完成节点并路由。`run.respond`只在等待中的 Run 上接受，`nodeRunId`必须匹配当前未决节点；重复作答或非法结果名一律拒绝且保持等待。放弃整个运行使用既有的`run.stop`，等待状态下同样有效。
3. **恢复。** daemon 重启后`run.resume`重新执行未决的 confirm 节点：重新渲染待评审文本并再次挂起，旧等待作废。已作答但尚未续跑的极端情况下，应答已持久化，恢复时仍被消费。

daemon 经 0700 目录下的 Unix socket 服务，应答与现有操作共享同一本机信任边界，不新增认证。

## 设计方向一：Flow 文件格式（spec）

结论：新增第四种动作标记`confirm`，格式完全复用现有节点结构，无任何新增声明语法。

动作代码块标记精确为`confirm`，内容是纯文本待评审说明，支持`{var.xxx}`与`{input.xxx}`模板引用：

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

- **结果边写法与 Agent 节点一致**：每条出边带结果名并有非空三级说明。选项即结果边，选项文案即三级标题与说明。一条结果边也合法（阅读确认后继续的"已知悉"型门禁）。
- **禁止项**：结果说明不允许变量表；不得作为并行分支或汇合节点（既有约束天然排除）；不新增元信息字段、图元素或目录约定。
- **解释器检查增量**：动作标记`confirm`、代码块为非空文本、文本参与既有模板校验（规则与 Agent 提示词一致）、结果说明无变量表。其余沿用 Agent 节点的出边检查，不新增检查类别。

## 设计方向二：工具与接口

结论：不新增 Agent 运行时工具；新增一个 daemon 操作、一个观察事件、一个控制台 API，以及两个状态值。

| 对象 | 结论 | 说明 |
| --- | --- | --- |
| Agent 运行时工具（`submit_flow_outcome`一类） | 不新增 | confirm 无模型参与，工具桥与 Agent 提示词渲染不动 |
| daemon 操作 | 新增`run.respond {id, nodeRunId, result}` | 仅等待中的 Run 接受；校验`nodeRunId`匹配未决节点、`result`属于该节点结果集合；非法一律拒绝且保持等待 |
| 观察事件 | 新增`run.awaiting_input` | 进入等待时发出，订阅者据此刷新界面 |
| Run 阶段 | 新增`awaiting_input` | 等待中的 Run 仍是 running 状态，非终态 |
| Job 状态 | 新增`waiting_input` | daemon 侧挂起标记，语义见实现文档 |
| 控制台 API | 新增`POST /api/v1/runs/:id/respond` | 透传 daemon`run.respond` |

## 设计方向三：模块划分

结论：不新增模块。confirm 是 core 的第五种动作，全部改动分布在既有模块内。

- confirm 没有自己的宿主端口或外部集成边界——对比 runtime-tools 持有工具桥端口、child-flow 持有子 Run 编排，拆出独立 ability 模块只会增加跨模块接口。
- 行为内聚点：解析在 core/definition（与四种既有动作同处），挂起与应答校验在 core/execution（与结果校验同处），daemon/worker 通道在 machine，展示在 web，预检拒绝并入既有 preflight。文件级改动清单见[实现改动](user-confirmation-impl.md)。

## 非目标与演进

- **结果变量收集**：confirm 节点固定不传值；确有需要时再按 ACP form 模式立项。
- **URL 模式**（OAuth 等带外交互）与**能力协商**：不进入本设计。
- **Agent 主动询问用户**（经 Agent 会话发起的 elicitation）：属于 Agent 宿主扩展，与本门禁正交。
- **子 Flow 与平台模式支持**：待应答目标定位与平台协议明确后放开。

## 验收标准

1. 含 confirm 节点的 Flow 运行至该节点时挂起：`run.get`返回`awaiting_input`，节点记录携带渲染后的`pendingInput`（说明与全部选项），观察事件`run.awaiting_input`已发出。
2. `run.respond`提交合法结果名：节点完成，流程沿该结果边继续到终态。
3. `run.respond`提交未声明的结果名、重复作答、对非等待 Run 或错误`nodeRunId`作答：一律拒绝且保持等待。
4. daemon 重启后`resume`重新提问并再次挂起；重启后已作答未消费的应答仍被正确消费。
5. 预检：结果说明携带变量表、并行分支中的 confirm 节点、引用闭包内 confirm 节点、平台模式携带 confirm 节点，均在运行前拒绝。
6. 等待状态下`run.stop`正常终止；取消后的 Run 不可`respond`。
7. 控制台在等待期间持续轮询，待确认卡片展示待评审文本与全部选项，点选后流程继续。
