---
parent: ../SPEC.md
references:
  - ../docs/design/flow-runtime/FLOW-CORE.md
  - docs/flow-spec.md
---

# Flow Core

## 功能意图

提供可独立安装的无状态 TypeScript SDK。宿主以 `ready` 生成待办，通过 `submit` 提交结构化结果并获得新快照。宿主持有运行、存储和执行。

## 关键功能与验收

### 单文档流程推进

#### 验收

- `ready` 接收 `FLOW.md` 和可选的流程标识、启动变量，校验定义并渲染首个待办。不支持的动作或包能力在此时拒绝。
- 普通新建 Agent 和人工确认通过同一接口选边。全局变量持续到后续步骤，边的局部变量只用于准备紧接着的待办。人工确认只提交结果名。
- 循环返回同一节点产生新 `stepId`；旧回执、未声明的结果或变量、缺失的下一步输入均拒绝且原快照不变。结束边清空 `current`，结果留在 `steps`。

### 独立安装与跨进程推进

#### 验收

- 在仓库外仅安装 SDK 压缩包，可从 TypeScript 导入接口，也可从 Node.js 直接调用，无需 Runtime 或 daemon。
- 新进程仅凭宿主传入的 JSON 快照和回执继续推进，无需原文、共享进程或 SDK 存储。
