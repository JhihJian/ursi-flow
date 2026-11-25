# ursi-flow-runtime

Flow 文件到最终结果的推进库，只包含三部分：引擎、过程日志实体、日志文件存储。需要 Node.js 22.19+。

```ts
import { readFile } from 'node:fs/promises'
import { FileLogStore, FlowEngine } from 'ursi-flow-runtime'

const engine = new FlowEngine({
  // 唯一的外部依赖：按节点名和提示词执行一次 Agent 调用，返回所选结果。
  executor: {
    async prompt(agentName, instruct) {
      return runAgent(agentName, instruct)   // { outcome, variables? }
    },
  },
  store: new FileLogStore('/var/lib/ursi-flow'),
})

const result = await engine.start({
  flow: { id: 'release-check', text: await readFile('FLOW.md', 'utf8'), path: 'FLOW.md' },
  variables: { 任务: '发布前检查' },
  cwd: '/srv/work',
})
```

`result` 是 `completed`、`awaiting_input` 或 `failed` 之一。人工确认节点返回 `awaiting_input` 和待决选项，调用方决定谁来作答：

```ts
const answered = await engine.respond(result.runId, result.pending.stepId, '通过')
```

## 三部分

| 目录 | 职责 |
| --- | --- |
| `src/engine` | 读取 FLOW.md、驱动每一步、把渲染好的提示词交给执行器、校验回执并交给 Flow Core 选边、产出最终结果。确认节点挂起等待应答，`resume` 从快照继续。 |
| `src/logs` | 过程日志的实体定义：运行头、节点进入、执行器回执与拒绝、确认待决与应答、选边、终态，以及可恢复快照和 `LogStore` 端口。 |
| `src/store` | `FileLogStore`：把日志实体落到文件，每条运行一个目录，事件按行追加，快照原子替换。 |

引擎只依赖 Flow Core 的 `ready`/`submit` 和 `LogStore` 端口。进程管理、HTTP、MCP、模型 SDK 都在宿主侧，见 [ursi-flow-host](../flow-host/README.md)。

## 能力边界

Flow Core 定义四种动作：`新建Agent`、`confirm`、`执行自定义命令`、并行开始点。引擎按这四种动作推进，宿主只提供会话与子进程。

`复用Agent`、`执行Flow`、Agent Profile、节点级执行器与包内资料引用已从格式移除，解析期直接报错，不做兼容。

## 日志布局

```text
<store 根目录>/runs/<Run ID>/
  run.json      运行头：Flow 标识、原文、启动变量、工作目录、开始时间
  snapshot.json 可恢复快照：Flow Core 上下文、状态、待决确认、最后事件序号
  events.jsonl  过程事件，一行一条，序号单调递增
```

- 运行头与快照分开写：头只写一次，快照每次推进后原子替换。
- 事件追加失败会让本次运行以 `store_failed` 失败，避免出现没有记录的推进。
- 快照保存完整 Flow Core 上下文，因为 `stepId` 由 Flow Core 生成，恢复无法只靠回放事件重建。

## 构建与测试

```sh
(cd ../flow-core && npm ci && npm run build)
npm ci && npm run build && npm test
```

`npm test` 用假执行器覆盖三段：串行 Agent 推进到终态、确认挂起与应答、连续非法结果导致失败、重启后从快照恢复、事件序号与快照一致。

## 相关入口

- 常驻服务、独立 CLI、MCP adapter 与本地/平台执行器：[ursi-flow-host](../flow-host/README.md)。
- 无状态推进 SDK：[Flow Core](../flow-core/README.md)。
- Flow 文件格式：[Flow 规范](../flow-core/docs/flow-spec.md)。
