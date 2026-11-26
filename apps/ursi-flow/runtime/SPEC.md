---
parent: ../SPEC.md
depends-on:
  - ../core/SPEC.md
  - ../executor/SPEC.md
references:
  - ../docs/flow-spec.md
  - ../README.md
---

# Flow Runtime

## 功能意图

把 FLOW.md 推到最终结果的库，只有三部分：引擎、过程日志实体、日志文件存储。执行 Agent 的唯一外部依赖是 `prompt(agentName, instruct)`，执行命令依赖 `command(invocation)`。库不提供守护进程、Socket、MCP 与模型 SDK。

## 关键功能与验收

### 从 Flow 文件到最终结果

引擎读取 FLOW.md 原文，复用 Flow Core 的 `ready`/`submit` 校验与选边，逐步调用执行器，直到终态或人工确认。

#### 验收

- `start` 返回 `completed`、`awaiting_input` 或 `failed`。完成结果带上最终全局变量与全部已完成步骤；每一步的结果名都属于该节点声明的结果边。
- 执行器收到节点名、已渲染的提示词、当前变量、允许的结果与尚未消费的被拒原因；返回 `{ outcome, variables? }`。结果变量只进入下一跳输入，全局变量按声明合并。
- 同一节点连续三次提交不允许的结果时本次运行失败，失败原因保留最后一次拒绝信息，前两次拒绝各写一条日志。
- 运行标识已存在时 `start` 抛冲突，不重复执行。

### 人工确认门禁

`confirm` 节点渲染提示后返回 `awaiting_input`，不调用执行器。调用方用 `respond(runId, stepId, result)` 提交一个结果名后继续。

#### 验收

- 等待状态携带节点名、渲染后的提示文本与全部结果边名。
- 结果名不属于该节点、`stepId` 不匹配当前等待、运行不在等待状态时，`respond` 抛错且不改变等待状态。
- 合法应答按该结果完成节点并继续路由；链式确认再次返回 `awaiting_input`。`pending` 可单独查询待决事实。
- `resume` 对等待中的运行重新给出待决确认：换新 `stepId`，旧 `stepId` 随即失效；不调用执行器，也不重跑已完成的节点。

### 过程日志与文件存储

#### 验收

- 每条运行写入运行头、可恢复快照与行式事件流，事件序号从 1 单调递增，快照序号等于最后一条事件序号。
- 事件覆盖节点进入（含提示词与变量）、执行器回执、被拒原因、确认待决与应答、选边去向与终态。
- 恢复只依赖快照：Flow Core 生成 `stepId`，事件回放不足以重建上下文。
- 事件写入失败使运行以 `store_failed` 失败；快照原子替换，不出现半写文件。
- 运行头保留 FLOW.md 原文，包被删除或修订后仍能读到这次运行的输入。

### 能力边界

#### 验收

- 执行四种动作：`新建Agent`、`confirm`、`执行自定义命令`、并行开始点。`复用Agent`、`执行Flow`、Profile、节点级执行器在解析期被拒绝，`start` 抛 `invalid` 且不创建运行目录。
- 命令步骤执行已渲染的 `request`；`output: "variables"` 时用 `readCommandVariables` 解析 stdout 的 `{"variables": {...}}` 信封，退出码非 0 仍按 `已执行` 路由，退出码与输出写入日志。
- 并行步骤并发执行全部分支命令，按分支提交 `{outcome: "已执行", variables?}`；校验分支结果、合并分支写入的全局变量、拒绝同名写入，然后生成汇合命令步骤。
- 引擎不读取模型配置、不启动子进程、不接触网络；替换执行器即可换掉模型与运行环境。
