# ursi-flow

把一份 `FLOW.md` 推到最终结果的交付包。包内有三个模块和一个运行入口：

| 目录 | 职责 |
| --- | --- |
| `core/` | 无状态推进 SDK：`ready` 生成待办，`submit` 提交结果并选边。纯函数，无 IO。 |
| `executor/` | 执行器契约 `prompt(agentName, instruct)` 与 `command(invocation)`，以及适配层。首个适配器是 `FakeExecutor`。 |
| `runtime/` | 推进引擎、过程日志实体与文件存储。读 `FLOW.md`，逐步调用执行器，按回执选边，写到磁盘。 |
| `run.ts` / `cli.ts` | 装配：把上面三者接成一次运行，并提供 `ursi-flow` 命令行。 |

## 快速开始

```sh
npm install
npm run build

node dist/cli.js run examples/review --var 主题=发布说明
```

`examples/` 里每个子目录是一个 Flow 包，`FLOW.md` 是唯一入口，包目录名就是 Flow 标识。命令行的行为：

- `run <FLOW.md|包目录>` 执行一次运行，日志写到 `<cwd>/.ursi-flow`，可用 `--store` 改。
- `--var 键=值` 传启动变量，可重复；值按 JSON 解析，失败按字符串处理。
- 遇到 `confirm` 节点：交互终端里直接问人选一条结果边，非交互终端打印等待状态并以退出码 3 结束。
- `--json` 输出结构化结果。

当前默认执行器是 `FakeExecutor`：Agent 节点按第一条结果边作答，命令节点返回退出码 0。它让 `FLOW.md -> 结果` 的链路在没有模型凭据时也能整体走通。

## 作为库使用

```ts
import { FakeExecutor, runFlow, readFlowPackage } from "ursi-flow";

const flow = await readFlowPackage("./flows/release-check");
const result = await runFlow({
  flow,
  executor: new FakeExecutor(),
  store: "/var/lib/ursi-flow",
  variables: { 任务: "发布前检查" },
  confirm: async (pending) => "批准",
});
```

只要实现 `FlowExecutor` 的两个方法，就能换成真实执行器：

```ts
import type { FlowExecutor } from "ursi-flow/executor";

const executor: FlowExecutor = {
  async prompt(agentName, instruct) {
    // instruct.text 已渲染，instruct.outcomes 是本步允许的结果边
    return { outcome: "送审", variables: { 摘要: "…" } };
  },
  async command(invocation) {
    // invocation.request 已渲染 command/args/stdin/cwd
    return { exitCode: 0, stdout: "", stderr: "" };
  },
};
```

执行器是可选清单：`builtinExecutors` 列出每个适配器的 `id`、标题、说明与 `create()`，宿主按 id 建实例。契约要求每个执行器带稳定 `id`，引擎会把它写进运行头，恢复时核对一致。

子路径导出：`ursi-flow`（运行入口与常用类型）、`ursi-flow/core`、`ursi-flow/core/runtime`、`ursi-flow/executor`、`ursi-flow/executor/fake`、`ursi-flow/runtime`。

## 执行器边界

契约只有两个方法，引擎只解释 `outcome`、`variables` 和命令输出。会话复用、模型选择、凭据、子进程、超时与并发都归适配器实现，不进入引擎语义。

`FakeExecutor` 的职责同样有限：按节点名消费预设脚本，没有脚本时取第一条结果边，并为本节点结果声明的变量填占位值，好让下一个节点能渲染。它不做提示词渲染、变量校验、选边或重试。

## 构建与测试

```sh
npm run build      # tsc 输出 dist/
npm test           # 构建后跑 SDK 用例（node:test）与引擎、执行器、闭环、CLI 用例（vitest）
npm run test:pack  # 打包并在仓库外离线安装、跑用例
```

日志布局是 `<store>/runs/<runId>/{run.json,snapshot.json,events.jsonl}`，事件序号单调递增，快照原子替换。

相关文档：[FLOW.md 规范](docs/flow-spec.md) · [Flow 导读](docs/flow-overview.md) · [模块规格](SPEC.md)
