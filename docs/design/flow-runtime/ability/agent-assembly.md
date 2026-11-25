# Agent Assembly

## 能力说明
根据 Flow 节点声明的 Profile 装配 Agent，Profile 的模型、Tools、Skills 和权限由宿主插件解析。

## 依赖说明
依赖 `core/contracts` 的 Assembly 端口。实际 Profile 解析、模型选择和工具装配由具体 Integration 提供。

## 启用与生命周期
新建 Agent 声明 Profile 时启用。Run 创建前预检，Agent 打开前装配，关闭时由 Agent Harness 释放。
