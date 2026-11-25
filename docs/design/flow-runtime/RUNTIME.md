# 精简运行时设计：引擎、日志实体与日志存储

Flow Runtime 收敛为一个只做一件事的库：把 FLOW.md 推到最终结果。它只有三部分：引擎、过程日志实体、日志文件存储。其他职责——进程管理、Unix socket、HTTP、MCP、模型 SDK、包修订与执行器绑定——都不在这个库里。

## 为什么这样切

此前的 `flow-runtime` 把四类东西放在一起：推进引擎、日志与事实存储、fork worker 与 daemon 协议、模型与平台执行器适配。结果是任何一处改动都要先分清当前在改哪一层，而真正体现用户价值的逻辑——读 Flow、执行一步、选边、给结果——被埋在两千行协调器和一层宿主胶水里。

收敛后的价值主线只有一句：**给定 FLOW.md 和一个执行器，跑出一份最终结果，并把每一步原样记下来。** 其余都是可选宿主。

## 三部分

### 引擎 `src/engine`

输入 Flow 原文、启动变量与工作目录，输出终态、待确认或失败。

```ts
const engine = new FlowEngine({ executor, store })
const result = await engine.start({ flow: { id, text, path }, variables, cwd })
```

- 推进规则完全来自 Flow Core 的 `ready` / `submit`：解析、变量校验、结果边合法性、下一跳输入都由它决定，引擎不复制规则。
- 每一步把节点名、渲染好的提示词、当前变量、可选结果与被拒原因交给执行器；执行器返回 `{ outcome, variables? }`。
- 执行器是唯一外部依赖：`prompt(agentName: string, instruct: Instruct): Promise<ExecutorReply>`。
- 同一节点连续三次提交不允许的结果时本次运行失败，保留最后一次拒绝信息。
- `confirm` 节点不调用执行器，返回 `awaiting_input` 与待决选项；`respond(runId, stepId, result)` 校验后继续。
- `resume(runId)` 从快照继续；等待中的运行只重新给出待决确认，不重复执行。
- `start` 的 Flow 已被执行过时抛冲突，不重复创建。

### 日志实体 `src/logs`

过程日志是实体定义，不是字符串。每条记录带 `runId`、单调递增的 `seq` 和 `at`，类型覆盖：运行开始、节点进入（含提示词与变量）、执行器回执、被拒原因、确认待决、确认应答、选边去向、恢复、完成与失败。

同一目录还定义两个持久化形态：

- `RunHeader`：Flow 标识、原文、启动变量、工作目录与开始时间。原文一并保存，包被删除或改动后仍能重建这次运行。
- `RunSnapshot`：Flow Core 上下文、运行状态、待决确认、失败原因与最后事件序号。

`LogStore` 是写入端口，引擎只依赖这四个方法：`create`、`append`、`saveSnapshot`、`load`。

### 文件存储 `src/store`

`FileLogStore` 每条运行一个目录：

```text
<根目录>/runs/<Run ID>/
  run.json      运行头，写一次
  snapshot.json 可恢复快照，原子替换
  events.jsonl  过程事件，一行一条
```

- 同一运行的写入串行排队，避免临时文件互相覆盖。
- 快照先写临时文件再改名，不出现半写文件。
- 事件追加失败让运行以 `store_failed` 失败：记录是这次运行唯一的凭证，不能静默丢弃。
- 快照必须保存完整上下文。Flow Core 的 `stepId` 在 `ready` 内部生成且不可注入，只靠回放事件无法恢复当前待办。

## 为什么保留快照

日志实体回答「发生过什么」，快照回答「现在在哪一步」。两者都不能省：

- 只要审计和过程回放，事件流就够。
- 要支持 `resume` 与 `respond`，必须能在重启后重建 Flow Core 上下文与未决 `stepId`。

因此快照不是冗余，而是恢复所需的最小状态；事件流不承担恢复职责。

## 宿主边界

`flow-host` 承接全部进程与集成职责：daemon、worker、运行登记、包修订、配置、本地 Pi 与平台执行器、MCP adapter、Rust 客户端。它们通过 `~/.ursi-flow/runtime.sock` 对外提供同一套操作。

这样切分的直接收益：

- `flow-runtime` 只依赖 `ursi-flow-core`，可以独立安装、独立测试，不需要模型凭据、不需要 socket。
- 换执行器等于换一个 `prompt` 实现，不需要改引擎。
- 宿主崩溃、重启、并发上限与凭据隔离都不会污染引擎语义。

## 能力边界

Flow Core 表达四种动作：`新建Agent`、`confirm`、`执行自定义命令`、并行开始点。引擎据此执行命令与并行，宿主只负责会话、子进程与平台调用。

`复用Agent`、`执行Flow`、Agent Profile、节点级执行器与包内资料引用已从格式移除：解析期报错，不再有兼容接线。宿主中的第二套协调器（`flow-host/src/core`）随之删除，运行状态与历史都来自引擎日志。

## 命令与并行

- 命令步骤在准备待办时渲染 `command`、`args`、`stdin`、`cwd`，其中 `{var.x}`、`{input.x}` 与（仅汇合节点）`{branch.x.y}` 会被代入，单独的引用保留 JSON 类型。
- 引擎执行命令后，`output: "variables"` 时用 `readCommandVariables` 解析 `{"variables": {...}}`，否则只记录退出码与输出。退出码非 0 不改变路由：命令节点只有 `已执行` 一条边，由后面的节点判断。
- 并行步骤一次给出全部分支的已渲染请求，宿主并发执行；引擎按分支收集结果并一次提交，Flow Core 校验后直接生成汇合命令步骤，`{branch.x.y}` 在此渲染。
- 两个分支写同一个全局变量时本次运行失败，不产生任何合并结果。

## 实施顺序

1. 建立三部分与包边界：`src/engine`、`src/logs`、`src/store`，导出收窄为单一入口。
2. 把 daemon、CLI、执行器适配、MCP、Rust 客户端迁到 `flow-host`，保持操作集合与数据目录不变。
3. 用假执行器验收引擎：串行推进、确认挂起与应答、非法结果上限、重启恢复、日志序号。
4. 接管宿主：CLI 与 daemon 的 worker 调用引擎，执行器适配实现 `prompt` 与 `command`，历史由日志投影。
5. 同步文档：`flow-runtime/SPEC.md`、`flow-host/SPEC.md`、根 `SPEC.md` 与架构索引。

## 验收

- `cd flow-runtime && npm test`：只有引擎与存储用例，不需要模型凭据。
- `cd flow-host && npm test`：daemon、CLI、执行器与 MCP 的既有验收。
- `cd flow-host/client && cargo test && python3 tests/acceptance.py`：协议与固定修订启动。
- `cd workbench/server && cargo test`：宿主协议形状未变。
- `spec_validate`：模块结构与文档引用有效。

## 风险

- 执行器接口只有 `prompt` 与 `command`，容易在实现里偷偷塞入会话、工具与凭据语义。约束是：引擎只解释 `outcome`、`variables` 与命令输出，其余状态归宿主。
- 快照包含完整上下文，随步骤线性增长。当前按运行单文件保存，超长运行的写放大需要观察；如果需要分片，先改快照实体，不改事件流。
- 移除动作是破坏性格式变更：旧的 `复用Agent`、`执行Flow` 包会在解析期报错，不做兼容。
