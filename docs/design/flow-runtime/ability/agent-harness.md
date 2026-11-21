# Agent Harness

## 能力说明
执行 Agent 节点的 Prompt，绑定 Run 级 Agent，并在每个 NodeRun 中承载独立的 Runtime Tool Bridge。

## 依赖说明
依赖 `core/contracts` 中的 `FlowAgentHarness`、`AgentRunExecutor` 和 Flow 类型。具体 Session、模型和工具协议由 `integrations/pi`、`integrations/codex` 或 `integrations/deepseek` 提供。

## 启用与生命周期
Agent 节点固定启用。Run 开始时绑定，NodeRun 完成或失败后释放，Run 结束、取消或恢复失败时关闭全部资源。
