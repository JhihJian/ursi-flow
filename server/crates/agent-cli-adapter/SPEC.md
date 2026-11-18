---
parent: ../../SPEC.md
depends-on:
  - ../agent-runtime/SPEC.md
  - ../domain/SPEC.md
---

# Agent CLI Adapter

## 功能意图

为 Flow 的 Runner 提供 CLI 执行和本地测试实现。适配器把角色能力渲染到工作区，通过注入的 ExecutionEnv 执行命令，将输出、产物和遥测事件交回 Flow。Pi RPC 会话及其进程监督属于沙箱 Runtime。

## 关键功能与验收

### 角色能力渲染

将角色提示词、模型、Skills、MCP 配置与凭据引用渲染为文件和 CLI 参数。具体 CLI 可扩展通用渲染计划。

#### 验收

- 生成的配置保留角色能力，凭据清单只含引用占位，不含明文。
- 拒绝越界路径和非法技能名，渲染文件可落盘并幂等清理。

### 执行与事件回流

CliAdapter 实现 Runner，回传执行输出和声明的产物。LocalEnv 提供本地执行替身，StubAdapter 用于确定性流程测试。

#### 验收

- 成功时返回输出与已声明的产物，渲染、启动与产物采集事件可由 Flow 的事件消费者接收。
- 命令非零退出报告执行失败，不自动重试；清理失败通过清理事件报告。
- StubAdapter 可回显输入、返回声明的产物或按输入模拟失败。
