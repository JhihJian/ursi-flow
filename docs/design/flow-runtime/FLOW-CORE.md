# Flow Core SDK 设计

`flow-core` 根据 `FLOW.md` 给出当前待办，再根据回执决定下一步。`flow-runtime` 执行待办、收取回执并保存运行。首步和后续步骤使用同一种待办，也使用同一种回执。

## 公开接口

```ts
ready(flowMd: string, options?: ReadyOptions): { context: FlowContext }
submit(context: FlowContext, result: StepResult): { context: FlowContext }

type Outcome = { outcome: string; variables?: FlowVariables }
type StepResult = Outcome & { stepId: string }
```

两者同步、无状态。`ready` 仅凭文档和可选的 `flowId`、启动变量创建首份快照。`submit` 仅凭传入的 `context` 和回执返回新快照。SDK 在两次调用之间不保留运行状态，JSON 快照可交给另一进程继续推进。

## 待办与回执

`current` 包含 `stepId`、`nodeRef`、`kind`（`agent` 或 `confirm`）、渲染好的 `prompt` 和 `options`。每个选项给出结果名、说明和允许提交的变量。Agent 可提交已声明的全局变量和所选边的局部变量，值必须是 JSON。

1. Agent 完成当前工作后、结束本轮前，通过 `submit_flow_outcome` 显式提交一次 `{ outcome, variables? }`。`outcome` 必须是当前待办的一条结果边名，即使只有一条边也照样提交。比如 `{ "outcome": "送审", "variables": { "摘要": "草稿已完成" } }`。
2. 宿主等执行正常结束并取得合法结果后，加上**派发时绑定的** `stepId`，调用 `submit(context, { ...payload, stepId })`，其中 `payload` 是收取的 `{ outcome, variables? }`。本地适配器从[工具回执](../../../flow-runtime/src/ability/agent-harness/executor.ts)取得结果，平台适配器在成功后读取[结果文件](../../../flow-runtime/src/executor-adapters/platform.ts)。Agent 无需知道 `stepId` 或整个 `context`。人工确认只选边，由宿主提交同样的回执，不带 `variables`。

业务上的「退回」或「未通过」只要是声明过的边，就能正常推进。执行异常、取消、结果尚未确认或没有合法回执时，由宿主处置，Core 保持当前待办。回复正文、日志和产物留在宿主；下游需要的摘要或产物引用应通过已声明的变量显式交接。

## Context

| 字段 | 内容 |
| --- | --- |
| `flow` | 固定的 JSON 流程定义，含 `id`、节点、结果边和变量声明。裸文本未指定 ID 时用 `inline` |
| `variables` | 当前全局变量 |
| `current` | 当前待办，流程结束时为 `null` |
| `steps[]` | 按顺序保存已完成的 `{ stepId, nodeRef, result: Outcome }` |

`nodeRef` 标识定义中的节点，`stepId` 标识一次访问，每次进入都生成新的全局唯一 ID。节点名从 `flow` 查，前驱和所走的边从 `steps` 查。原文用于初始化，需要展示时由宿主保存。局部 `input` 仅用于准备下一待办，不单独存入快照。这样 `current` 是唯一的待办，`steps` 是唯一的流程历史。

## 统一推进

`ready` 从 `start` 找到首节点，以初始化后的全局变量和空的 `input` 准备待办。`submit` 校验回执，更新全局变量，并把所选边的局部变量作为下一步的 `input`。进入工作节点时，两者共用同一套待办生成逻辑。

| 当前 | 操作 | 结果 |
| --- | --- | --- |
| 无快照 | `ready` | `steps` 为空，`current` 为首个待办 |
| 有待办 | `submit` 选中工作节点 | 记录本步结果，`current` 换为下一次访问 |
| 有待办 | `submit` 选中结束边 | 记录本步结果，`current = null` |
| 已结束，或提交无效 | `submit` | 拒绝，原快照不变 |

回执无效包括旧 `stepId`、未声明结果或变量，以及缺少下一步渲染所需的输入。到达 `finish` 表示流程走完，业务结论由最后一步的结果表达。SDK 只校验传入的快照；最新快照和并发受理由宿主管理。

## 首版范围与验收

首版支持单文档、单一待办、分支和循环，动作限普通 `新建Agent` 与 `confirm`。Runtime 复用 Core 的解析、变量和路由规则，继续管理其原有的执行、事实提交与恢复。Core 快照是宿主的新调用接口，与 Runtime 的 Run 记录用途不同。

用「起草、审核、退回或批准」验收：主循环对首步和返工步骤使用同一套派发和提交；起草的摘要交给审核，漏交时停在起草；返工后旧回执被拒绝；跨进程传 JSON 快照可继续；批准后 `current` 为 `null`。
