# Agent 会话

## 能力说明

每个 `新建Agent` 节点产生一次独立的模型会话；提示词由 Flow 正文、允许的结果与提交指令组成，结果通过 `submit_flow_outcome` 工具回执交回引擎。

## 依赖说明

引擎只调用执行器的 `prompt(agentName, instruct)`。会话、模型、工具与凭据都由宿主实现；宿主侧的 `AgentHarness` 提供 `open`、`run`、`close`，本地执行器用 Pi SDK 实现它。

## 启用与生命周期

Flow 含 Agent 节点时启用。一次节点访问开一个会话，取得合法回执后关闭；同一节点连续三次提交不允许的结果时本次运行失败。执行器无法确认结果时，运行进入待核实，由 `resume` 只核实原尝试。
