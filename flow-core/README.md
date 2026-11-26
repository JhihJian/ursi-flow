# ursi-flow-core

`ursi-flow-core` 是面向 Node.js 22.19+ 的 ESM / TypeScript SDK。它把一份 `FLOW.md` 转成可执行的待办，再按宿主提交的业务结果选边。执行 Agent、发起人工确认、保存快照和受理重试由宿主负责。

Flow 的用途和整体方式见[Flow 概览](docs/flow-overview.md)，文件和包目录格式见[Flow 规范](docs/flow-spec.md)。

## 安装

在仓库的 `flow-core/` 目录构建压缩包：

```sh
npm ci
npm pack
```

在消费项目安装生成的 `ursi-flow-core-0.1.0.tgz`。包内包含解析器依赖，不需要安装 Flow Runtime、Pi 或 daemon。

```sh
npm install /path/to/ursi-flow-core-0.1.0.tgz
```

## 推进流程

给[起草与审核示例](examples/review/FLOW.md)提供启动变量，然后提交 Agent 的结构化结果：

```ts
import { readFileSync } from "node:fs";
import { ready, submit, type FlowContext } from "ursi-flow-core";

const md = readFileSync("FLOW.md", "utf8");
const { context: draft } = ready(md, { variables: { 主题: "发布说明" } });
if (draft.current?.kind !== "agent") throw new Error("预期起草待办");
const { context: review } = submit(draft, {
  stepId: draft.current.stepId,
  outcome: "送审",
  variables: { 摘要: "草稿已完成" },
});

// 另一进程只需读取宿主保存的 JSON 快照。
const restored: FlowContext = JSON.parse(JSON.stringify(review));
if (restored.current?.kind !== "confirm") throw new Error("预期审核待办");
const { context: done } = submit(restored, {
  stepId: restored.current.stepId,
  outcome: "批准",
});
console.assert(done.current === null);
```

每次访问都有独立的 `stepId`，循环返回同一节点时也会生成新 ID。宿主派发 `current.prompt` 和 `current.options`，只在执行正常结束且取得合法业务结果后，绑定派发时的 `stepId` 提交。人工确认仅提交选项名。`current === null` 表示已到达结束边，最后的业务结果可从 `steps` 读取。

命令与并行的完整走法见[检查流水线示例](examples/pipeline/FLOW.md)。

两个接口均同步返回 `{ context }`，非法提交抛出错误并保留原快照。把快照作为只读值保存，只用最新快照受理提交。SDK 不会跟踪旧快照是否已用过，并发时需由宿主保证同一版本只被接受一次。

支持四种动作：`新建Agent`、`confirm`、`执行自定义命令`，以及并行开始点（两条以上命令分支汇合到一个命令节点）。`复用Agent`、`执行Flow`、Agent Profile、节点级执行器和包内资料引用已从格式中移除。

命令步骤给出已渲染的 `request`（`command`、`args`、`stdin`，可选 `cwd`）与 `output` 标记；宿主执行命令，`output: "variables"` 时用 `readCommandVariables(stdout)` 解析 `{"variables": {...}}` 信封，再把 `{outcome: "已执行", variables}` 提交回来。

并行步骤一次给出全部分支请求，宿主并发执行后按分支提交 `{stepId, branches: {分支引用: {outcome: "已执行", variables?}}}`。SDK 校验每个分支的结果与变量、合并分支写入的全局变量、检查同名写入冲突，然后生成汇合命令步骤，`{branch.分支.变量}` 在汇合请求里渲染。

`ursi-flow-core/runtime` 导出解析、规则与变量工具，供 [Flow Runtime](../flow-runtime/README.md) 复用。

在 `flow-core/` 运行 `npm test` 可验证流程推进和跨进程交接，`npm run test:pack` 检查仓库外的离线安装。
