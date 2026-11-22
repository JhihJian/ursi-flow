---
parent: ../../../SPEC.md
depends-on:
  - ../../../../../executor-platform/server/src/work/executor/SPEC.md
---
# Workbench 工作包执行入口

## 功能意图

Workbench 提交工作包材料，执行器发布、执行尝试和制品存储由[独立平台](../../../../../executor-platform/server/SPEC.md)负责。

## 关键功能与验收

### 固定版本执行

#### 验收

- Workbench 用户可选择已发布版本、提交工作包、查询或取消本角色的尝试，读取已发布制品；不能经业务服务发布或停用执行器。
- 业务目录 ID 在本地解析。`platform-artifact-{attemptId}` 按尝试在远程平台解析，不能用于写入业务目录。
- 尝试驱动和文件实现在平台的 [mod.rs](../../../../../executor-platform/server/src/work/executor/mod.rs) 和 [files.rs](../../../../../executor-platform/server/src/work/executor/files.rs)。
