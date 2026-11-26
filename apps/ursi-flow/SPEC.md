---
parent: ../../SPEC.md
depends-on:
  - core/SPEC.md
  - executor/SPEC.md
  - runtime/SPEC.md
references:
  - ../../ARCHITECHTURE.md
  - docs/flow-spec.md
  - ../../docs/design/flow-runtime/RUNTIME.md
---

# ursi-flow

## 功能意图

把一份 `FLOW.md` 推到最终结果并交付安装包。包内三个模块各司其职：`core` 决定下一步做什么，`executor` 决定这一步怎么执行，`runtime` 负责推进、记录与恢复。包自身提供一次运行的装配与命令行入口，让用户不必写宿主代码就能执行一个 Flow 包。

## 关键功能与验收

### 一次运行从文件走到结果

#### 验收

- `runFlow` 接收 Flow 源、执行器、存储位置与启动变量，返回 `completed`、`awaiting_input`、`failed`、`unconfirmed` 或 `interrupted`；传入 `confirm` 时自动把等待中的确认问到人并继续。
- `readFlowPackage` 接受包目录或 `FLOW.md` 路径，返回 Flow 标识（目录名）、原文与路径。
- 同一运行标识重复执行时报冲突，不重跑、不覆盖已有日志。
- `examples/` 下的示例 Flow 只配 `FakeExecutor` 即可跑出结果，命令与并行节点按脚本回执。

### 命令行交付

#### 验收

- `ursi-flow run <FLOW.md|包目录>` 执行一次运行，日志写入 `<cwd>/.ursi-flow`，可用 `--store` 指定根目录。
- `--var 键=值` 可重复，值按 JSON 优先解析；缺少取值或未知选项给出用法说明并以非零码退出。
- 交互终端遇到 `confirm` 节点时列出可选结果并接受序号或结果名；非交互终端打印等待状态与可选结果，退出码为 3。
- `--json` 输出最终结果对象，便于其他程序消费。

### 模块与导出

#### 验收

- 子路径导出覆盖运行入口、`core`、`core/runtime`、`executor`、`executor/fake` 与 `runtime`，每个入口都有类型声明。
- 包可 `npm pack` 后在仓库外离线安装：`ursi-flow/core` 可直接导入并推进流程，`yaml` 随包携带。
- 模块依赖单向：`core` 不依赖其他模块；`executor` 只依赖 `core` 的类型；`runtime` 依赖 `core` 与执行器契约；包入口依赖三者。

### 执行器契约与适配层

#### 验收

- 契约只有 `prompt(agentName, instruct)` 与 `command(invocation)` 两个方法，引擎之外的能力（模型、会话、凭据、子进程、超时）全部由适配器实现。
- `FakeExecutor` 按节点名消费预设脚本，没有脚本时取第一条结果边并为本节点结果声明的变量填占位值；同一运行内超过预设调用上限即报错，避免循环流程跑死。
- 适配器不渲染提示词、不校验变量、不选边、不写日志；这些行为只由 `core` 与 `runtime` 决定。
