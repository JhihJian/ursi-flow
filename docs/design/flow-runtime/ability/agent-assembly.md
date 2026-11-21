# Agent Assembly

## 能力说明
根据 Flow 的 Profile、模型、Tools、Skills 和权限声明装配 Agent。

## 依赖说明
依赖 `core/contracts` 的 Assembly 端口和 Agent 能力声明。实际 Profile 解析、模型选择和工具装配由具体 Integration 提供。

## 启用与生命周期
新建 Agent 使用 Profile 或声明 Tools、Skills 时启用。Run 创建前预检，Agent 打开前装配，关闭时由 Agent Harness 释放。
