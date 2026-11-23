---
parent: ../../../SPEC.md
references:
  - ../../../../../docs/design/executor-platform/OVERVIEW.md
  - ../../../../../docs/design/executor-platform/ACP-PROFILE.md
---
# 平台执行尝试

## 功能意图

平台用固定后端执行调用方的指令和输入快照。每次尝试使用独立的 worker 和 ACP v2 stdio 连接，并以 `attemptId` 查回状态、归一化事件和只读制品。

## 关键功能与验收

### 固定版本与身份

#### 验收

- 已认证的 Workbench 或 Runtime 以小写标准 UUID 调用 `PUT /api/v2/executor-attempts/{id}`，指定 `executorRef: {id, revision}` 和 UTF-8 指令。管理员可改用 `previewDefinition` 试跑草稿，不分配修订号；两种目标互斥。
- 使用该次试跑或已发布 ACP 修订的冻结 Agent 配置。worker 在提交任务前核验私有 `0400` 的 `agent-config.json` 及摘要，再按原绑定建立 ACP v2 会话。旧 MCP 修订须重新发布为 ACP 修订才能用于新尝试。
- 同角色、同 ID、同请求（含输入摘要）查回原尝试；变更指令、修订、运行配置或输入返回 409。每次尝试至多提交一次 `session/prompt`；绑定失效时不改选后端。

### 查回与取消

#### 验收

- 启动回执丢失或 HTTP 服务重启后，原角色用 `GET /api/v2/executor-attempts/{id}` 查原尝试。存活的 worker 继续执行；查询及相同 PUT 不重发任务。
- `POST /api/v2/executor-attempts/{id}/cancel` 为原尝试登记取消意图。确认停止后才可报告取消；已确认并发布的结果保持原样。缺少可信终态或停止证据时为 `unverified`。
- 切换前平台已发布的完成结果可用原角色、原 ID 查回。未完成的旧协议尝试不转接到 ACP。

### 输入快照与终态制品

#### 验收

- 显式 `inputs` 快照放入本次 `workspace/inputs/`，后端只从 `workspace/artifacts/` 交付制品。平台 API 不接受 Workbench 本地包 ID 或任意宿主路径作为输入。
- 确认终态和受管写入方停止后，平台从输出区收集制品。发布后原角色可用 `artifactDirectoryId` 读取只读目录及文件；跨角色读取返回 404。

### 归一化事件分页

#### 验收

- 原角色可调用 `GET /api/v2/executor-attempts/{id}/events?after=0`，在运行中或完成后读取 `{events, nextCursor}`。传回 `nextCursor` 续读，只返回已提交且 `seq` 大于游标的事件。未认证返回 401，其他角色（含管理员）或不存在的尝试返回 404。
- 可选 `waitMs` 接受非负整数，默认 `0`，上限 8000 毫秒。有可读记录立即返回；游标已追平且已观察到 worker 持锁运行时，等到下一帧、worker 停止或等待期限届满。等待期间同一尝试仍可取消。旧协议尝试立即返回空页。
- 轨迹按序保留脱敏 RPC 过程、状态、回复片段、工具更新与可记录的采集缺口。`rpc` 事件只包含 `seq`、`kind`、`method` 和 `phase`。事件页独立于终态及制品发布。
