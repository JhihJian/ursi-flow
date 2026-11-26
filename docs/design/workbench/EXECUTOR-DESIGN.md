# Workbench 执行器设计

Workbench 将**发布执行器定义**与**发起一次执行尝试**分开。定义描述可复用的能力，按修订保存。尝试由调用方提供的 `attemptId` 标识，记录本次使用的指令、材料、执行目标和结果。Flow 与 Agent 共用尝试接口和制品发布流程，但执行目标的来源不同：Flow 由部署者固定，Agent 取自发布的修订或试跑草稿。

## 定义与执行目标

[资源与执行器目录](../../../workbench/server/src/work/catalog/HTTP.md)管理定义及其历史修订。普通执行器定义可引用固定版本的提示词和 Skill，供查阅和复用。Agent 定义引用可编辑的配置包，发布时将解析出的配置快照和选定的后端绑定到具体修订。发布只保存定义，不启动尝试。

调用方通过同一个尝试接口选择以下目标：

| 路径 | 请求如何选择 | 配置与后端来源 |
| --- | --- | --- |
| [Agent 按版本运行](PI-AGENT-EXECUTOR-DESIGN.md) | 提交 `executorRef` | 使用已发布修订保存的配置快照和后端绑定。编辑配置包或发布新版不会改变旧修订的快照。 |
| [Agent 草稿试跑](PI-AGENT-EXECUTOR-DESIGN.md#何时读取配置) | 提交 `previewDefinition` | 读取配置包当前内容，从管理员登记的后端中选取就绪且兼容的一个，固定为本次尝试的快照和绑定。试跑不发布修订。 |

`executorRef` 和 `previewDefinition` 互斥。工作包只提供本次材料，Agent 的配置来自执行器修订或试跑草稿。适配器路径、策略和凭据由部署者控制。这里的本机 stdio 执行后端与[平台 MCP 服务](../../../workbench/server/src/work/mcp/PLATFORM.md)是不同的入口。

## 尝试如何完成

1. **准备输入。** Workbench 记录本次请求，把可选工作包的文件复制到 `inputs/`，为输出分配独立的 `artifacts/` 目录。Agent 尝试同时保存只读配置快照。
2. **交给后端执行。** Workbench 通过[执行器 MCP 协议](../../EXECUTOR-MCP.md)向适配器发起启动、查询或取消。Workbench 持有尝试记录、输入和已发布的制品，后端持有自身的运行记录。
3. **发布结果。** Workbench 确认终态并收集完 `artifacts/` 后，才通过 `artifactDirectoryId` 提供只读制品目录。状态待核实时，调用方可继续查询。

## 回执丢失与重试

启动回执丢失时，用原 `attemptId` 发 GET 核对状态。GET 只查询原运行并按需收集制品。同一 ID 和参数复用原尝试，必要时可用相同 PUT 显式重发幂等启动。改动参数或主动再执行一次须使用新 ID。取消以实际后端状态为准。

查询、取消和重复启动都沿用首次登记的后端绑定。尚未确认终态时，原后端被移除或部署绑定发生变更，Workbench 返回 503，不会自动切换后端。

HTTP 请求、部署配置及制品读取方式见[执行器接入说明](../../../workbench/EXECUTOR-INTEGRATION.md)，验收条件见[执行器尝试规格](../../../workbench/server/src/work/executor/SPEC.md)。
