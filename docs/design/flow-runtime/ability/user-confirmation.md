# 用户确认门禁节点

## 背景与目标

Flow 的判断目前只有两种来源：Agent 节点由运行中的模型提交结果，命令节点固定提交`已执行`。部署、发布、删除资源这类敏感操作缺少第三种判断：由人确认后才继续。用 Agent 节点充当确认环节会引入一次模型调用，模型可能误选结果，也无法可靠收集结构化表单。

本设计为 Flow 增加第五种动作`用户确认`：运行到该节点时挂起，等待人在控制台作答，答案经校验后成为节点结果并驱动路由。交互契约参考 [ACP v2 Elicitation](https://agentclientprotocol.com/protocol/v2/elicitation)：

- form 模式的受限字段模型（文本、单选、布尔、多选），服务端对提交值再校验；
- 明确的是/否两态与清晰的拒绝入口；
- 客户端预填默认值并允许修改后提交；
- 表单不用于收集密钥、令牌等凭据。

ACP 的 URL 模式（带外交互）、能力协商和 accept/decline/cancel 三态中的 cancel 不进入本设计，见"非目标"。

## 关键决定

1. **`用户确认`是 Runtime 动作，不是节点类型。** 它与`执行自定义命令`平级，进入既有的动作分发和结果边模型。结果边固定为`已确认`和`已拒绝`两条，复用"门禁是节点结果边"的既有心智模型，Agent、Session 与结果工具桥都不参与。
2. **交互只有两态。** ACP 的 decline 与 cancel 在流程门禁里语义相同：未获批准。合并为`已拒绝`一条结果边。放弃整个运行由 Run 级`run.stop`承担，不引入第三条边。
3. **挂起即 worker 干净退出，应答即重启 worker。** daemon 与 worker 之间只有一次性启动 IPC，没有双向通道。运行到确认节点时 worker 以 awaiting 标记退出，daemon 把 Job 置为`waiting_input`；`run.respond` 把应答写入 job.json 后以应答模式重启 worker，worker 把应答转成节点结果事实并续跑。该模型复用现有的启动、恢复与终态推导，daemon 重启后仍可作答。
4. **恢复等于重新提问。** 未决确认的 Run 在 daemon 重启后执行`run.resume`，worker 重新执行确认节点、重新渲染问题并再次挂起，旧等待作废。已有恢复路径不需要特判。
5. **Runtime 是唯一的答案校验点。** 表单字段声明来自受信任的流程作者，提交值来自用户。Runtime 对作答做完整校验：字段名必须落在声明集合内，值类型必须匹配字段类型，多选不得超出选项。未经校验的值不进入任何变量。
6. **平台执行器模式与子 Flow 引用闭包暂不支持。** 平台模式下 Agent 节点在平台侧执行，确认门禁的挂起与应答通道在 daemon 侧，两者不能混用；启动时预检直接拒绝。被引用 Flow 中的确认节点同样在预检拒绝，应答目标定位后续再放开。

## Flow 文件格式

动作代码块标记为`用户确认`，内容是一个 JSON 对象：

```json
{
  "message": "即将发布 {var.项目} 到生产环境，请确认。",
  "fields": [
    { "name": "发布说明", "title": "发布说明", "type": "text", "required": true },
    { "name": "渠道", "title": "发布渠道", "type": "select", "options": ["灰度", "全量"], "default": "灰度" },
    { "name": "通知", "title": "发送通知", "type": "boolean", "default": true },
    { "name": "跳过项", "title": "跳过的检查", "type": "multiselect", "options": ["lint", "性能"] }
  ]
}
```

- `message`必填。`{var.xxx}`等模板引用照常渲染，渲染后的文本作为提问快照持久化。
- `fields`是表单声明，可省略（纯是/否确认）。每项：
  - `name`：字段名，即`已确认`结果的变量名；
  - `title`：展示名，必填；`description`可选；
  - `type`：`text`、`select`、`boolean`、`multiselect` 之一；
  - `select`与`multiselect`必须有非空`options`；`default`（可选）必须落在选项内；
  - `required`默认 false。
- 结果边恰为两条：`### 已确认`与`### 已拒绝`，说明非空。`已确认`的变量表必须逐项声明全部字段名（名称集合相等），值经字段类型校验后按既有结果变量规则流转：全局同名写入 Run 状态，其余作为下一跳 `input`。`已拒绝`不带变量。

```markdown
## 确认发布

```用户确认
{ "message": "即将发布 {var.项目}。", "fields": [ { "name": "渠道", "title": "发布渠道", "type": "select", "options": ["灰度", "全量"] } ] }
```

### 已确认

| 变量 | 含义 |
| --- | --- |
| 渠道 | 本次发布渠道 |

### 已拒绝

本次发布未获批准。
```

解释器新增检查：动作标记`用户确认`；JSON 含非空`message`与可选`fields`；字段名是合法变量名且不重复；类型白名单；`已确认`/`已拒绝`双结果边且`已确认`变量表与字段集合一致。并行分支与汇合只允许命令节点，确认节点天然被拒。首节点规则不变：此时`message`不得引用`{input.xxx}`。

## 运行时行为

一次确认经历三个阶段，事实全部持久化：

1. **等待（pending）。** Runtime 渲染`message`与`fields`，创建 NodeRun（状态 running，无 session），把渲染后的提问快照记入该记录的`pendingInput`，Run 进入新阶段`awaiting_input`，发出观察事件`run.awaiting_input`，worker 以 awaiting 标记干净退出，daemon 把 Job 置为`waiting_input`。等待中的 Run 仍处于 running 状态，不是终态。
2. **应答（answered）。** 控制台调用`run.respond {id, nodeRunId, decision, values?}`：
   - `accept`：`values`按`pendingInput.fields`校验（未知字段、类型不符、多选越界均拒绝并保持等待），通过后作为`已确认`结果完成节点，节点记录`confirmation`证据（decision 与最终生效的 values），按结果边续跑。续跑途中再遇确认节点则再次挂起，链式确认天然支持。
   - `decline`：以`已拒绝`结果完成节点，记录`confirmation`，无变量。
   - 拒绝与取消按钮在界面上都指向`decline`；放弃整个运行使用既有的`run.stop`，等待状态下同样有效。
3. **恢复（re-question）。** daemon 重启后`run.resume`放行本地`waiting_input`的 Run：worker 走既有恢复路径，中断未决的确认节点并重新进入，渲染新提问再次挂起。已作答但 worker 中断的极端情况：应答已写入 job.json，重启后 respond 模式续跑仍消费该应答。

`run.respond`只在`waiting_input`状态接受，且`nodeRunId`必须匹配当前事实中的未决节点。重复作答、对已完成或非确认节点作答一律拒绝。daemon 经 0700 目录下的 Unix socket 服务，应答与现有操作共享同一本机信任边界，不新增认证。

## 模块改动

| 模块 | 改动 |
| --- | --- |
| `core/contracts/types.ts` | `FlowAction`增加`UserConfirmationAction`；`RunPhase`增加`awaiting_input`；`NodeRunRecord`增加可选`pendingInput`与`confirmation`；观察事件增加`run.awaiting_input` |
| `core/definition/parser.ts` | 动作解析新增`用户确认`分支与字段校验；图校验增加双结果边与变量表一致性检查 |
| `core/execution/runtime.ts` | 动作分发新增确认分支（渲染、记 pending、进入等待）；新增公开`respond`方法复用"从已完成节点续接"路径；挂起经 sentinel 异常干净返回，子 Flow 边界外不传播 |
| `core/execution/preflight.ts` | 平台执行器模式与引用闭包内确认节点的预检拒绝 |
| `machine/worker.ts` | 捕获等待 sentinel：发 awaiting 标记并干净退出；新增应答模式（读 job.json 应答 → `runner.respond` → 续跑） |
| `machine/runs.ts` | Job 状态`waiting_input`；close 推导优先采纳 awaiting 标记；新增`respond`（校验、写 job.json、重启 worker）；`resume`放行本地`waiting_input` |
| `machine/daemon.ts` | 新操作`run.respond` |
| `web` | 轮询条件纳入`waiting_input`；详情页增加待确认卡片：渲染 message、按字段类型渲染表单、预填 default、提供确认与拒绝；新增 respond API 透传 |
| 文档 | `flow-spec.md`新增动作章节与解释器检查；本设计登记进架构索引 |

测试沿用现有布局：解析与运行时用 vitest（`test/parser.test.ts`、`test/runtime.test.ts`），daemon 与 worker 全链路用 node:test（仿`local-pi.test.mjs`）。

## 非目标与演进

- **URL 模式**（OAuth 等带外交互）：需要外部完成回查的状态机，单独立项。
- **能力协商**：本地 daemon 固定支持 form 交互，不复制 ACP 的 capabilities 握手。
- **Agent 主动询问用户**（ACP elicitation 的原始场景，经 Agent 会话发起）：属于 Agent 宿主与 Runtime 工具桥的扩展，与本门禁正交。
- **子 Flow 与平台模式支持**：待应答目标定位与平台协议明确后放开。

## 验收标准

1. 含确认节点的 Flow 运行至该节点时挂起：`run.get`返回`awaiting_input`，节点记录携带渲染后的`pendingInput`，worker 已退出且不占并发额度。
2. `accept`携带合法 values：节点完成并持久化`confirmation`，values 按`已确认`变量表成为下一跳 `input`（全局同名写入 Run 状态），流程到终态。
3. `accept`缺必填字段、携带未知字段或类型不符：拒绝且 Run 保持等待，可重新作答。
4. `decline`：走`已拒绝`边，无变量。
5. 重复`respond`、对非等待 Run 或错误`nodeRunId`的`respond`：一律拒绝。
6. daemon 重启后`resume`：重新提问并再次挂起；重启后`respond`仍可完成应答并续跑。
7. 预检：`已确认`/`已拒绝`边缺失、变量表与字段集合不一致、非法字段类型、并行分支中的确认节点、引用闭包内确认节点、平台模式携带确认节点，均在运行前拒绝。
8. 等待状态下`run.stop`正常终止；取消后的 Run 不可`respond`。
9. 控制台在等待期间持续轮询，待确认卡片渲染 message 与全部字段、预填 default，用户修改后提交生效。
