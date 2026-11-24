# ursi-flow-core

`ursi-flow-core` 是面向 Node.js 22.19+ 的 ESM / TypeScript SDK。它把一份 `FLOW.md` 转成可执行的待办，再按宿主提交的业务结果选边。执行 Agent、发起人工确认、保存快照和受理重试由宿主负责。

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

两个接口均同步返回 `{ context }`，非法提交抛出错误并保留原快照。把快照作为只读值保存，只用最新快照受理提交。SDK 不会跟踪旧快照是否已用过，并发时需由宿主保证同一版本只被接受一次。

首版支持单文档、单一待办、分支、循环、普通 `新建Agent` 和 `confirm`。复用 Agent、专用执行器、Agent Profile、业务能力装配、包内资料、命令、子 Flow 和并行由 [Flow Runtime](../flow-runtime/README.md) 提供。`ursi-flow-core/runtime` 是 Runtime 使用的共享规则入口，SDK 调用方从 `ursi-flow-core` 导入。

在 `flow-core/` 运行 `npm test` 可验证流程推进和跨进程交接，`npm run test:pack` 检查仓库外的离线安装。
