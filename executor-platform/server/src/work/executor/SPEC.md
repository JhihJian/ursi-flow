---
parent: ../../../SPEC.md
references:
  - ../../../../../docs/EXECUTOR-MCP.md
  - ../../../../../docs/design/executor-platform/OVERVIEW.md
---
# 平台执行尝试

## 功能意图

平台把调用方的指令和输入快照交给固定后端，用同一个 `attemptId` 核对状态并发布只读制品。Workbench 接收业务工作包 ID 并生成输入快照，执行尝试及其工作区归平台所有。

## 关键功能与验收

### 固定版本与身份

#### 验收

- 已认证的 Workbench 或 Runtime 以小写标准 UUID 调用 `PUT /api/v2/executor-attempts/{id}`，指定 `executorRef: {id, revision}` 和 UTF-8 指令。只有管理员可用 `previewDefinition` 替代修订进行试跑；两种目标互斥。
- 发布修订使用平台冻结的 Agent 配置和固定后端。草稿按所选配置包和兼容且就绪的后端生成本次快照，不分配修订号。平台以部署者指定的程序和策略经 stdio MCP 调用后端。
- 同角色同 ID 同请求（包括输入摘要）复用原尝试，变更指令、版本、运行配置或输入返回 409。其他角色不能使用该 ID 访问已登记的尝试。

### 查回与取消

#### 验收

- 启动回执丢失或平台重启后，原角色 `GET /api/v2/executor-attempts/{id}` 核对原后端或返回已发布结果，不重发启动。`POST /api/v2/executor-attempts/{id}/cancel` 只取消原尝试。
- 无法确认终态时，`unverified` 不代表成功或已取消。既有尝试不因探测状态变化改选后端；绑定失效时不切换程序重跑。

### 输入快照与终态制品

#### 验收

- 每次尝试有独立工作区；调用方上传的 `inputs` 放在该次 `inputs/`，后端向 `artifacts/` 写出结果。平台 API 不接受 Workbench 本地包 ID 或任意宿主路径作为输入。
- Agent 的 `agent-config.json` 按尝试私存，权限为 `0400`；重发启动前核对摘要，文件缺失或改变时拒绝启动。
- 确认终态并完成收集后，原角色可按 `artifactDirectoryId` 读取文件树与正文。目录只读，内容仅来自输出区。即使尝试已结束，其他角色读取也返回 404。
