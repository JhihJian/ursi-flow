# Runtime Tools

## 能力说明
为每个 NodeRun 提供一次性 `submit_flow_outcome` 工具，严格校验结果、变量和生命周期，并把结构化结果交回 Core。

## 依赖说明
依赖 `core/contracts` 的结果声明、变量值和 Runtime Tool 类型。不依赖具体模型、Session 或平台。

## 启用与生命周期
Agent 节点固定启用。NodeRun 开始时创建，成功提交后冻结，节点结束、失败、取消或关闭时撤销迟到调用。
