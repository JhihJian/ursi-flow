---
parent: ../../SPEC.md
references:
  - README.md
  - ../../docs/design/executor-platform/OVERVIEW.md
  - ../../docs/design/executor-platform/ACP-BACKEND.md
  - src/work/agent_backends/README.md
---
# 执行器平台服务

## 功能意图

平台是配置包、资源和执行器修订、后端绑定、执行尝试及其制品的唯一管理服务。Workbench 与 Flow Runtime 通过 HTTP 提交 `executorRef: {id, revision}` 和输入文件快照，平台按该版本启动受管 worker，由 worker 经本机 ACP v2 stdio 执行任务。整条 Flow 由 Runtime 编排，独立的整条 Flow MCP 集成在平台之外。

## 关键功能与验收

### 独立部署与持久化

#### 验收

- 从平台自己的 Cargo 清单和锁文件构建并启动服务，无需启动 Workbench 或 Flow Runtime。缺少角色令牌或角色令牌重复时拒绝启动。
- 平台独占私有数据目录；第二个实例或使用 Workbench 数据根作为平台存储均启动失败。平台不读写 Workbench 的 `work.json`。
- 用同一平台目录重启可查回发布修订、冻结快照、后端绑定、尝试归属、已提交事件和已发布制品。后端健康检查随进程重置，新发布或试跑须重新检查，既有绑定保持原样。
- 切换到 ACP 后，原平台已完成的结果与已发布制品仍可由原角色按原 ID 查回。旧 MCP 修订仅保留历史，新执行须发布并选用 ACP 修订。

### 管理权限与消费权限

#### 验收

- 管理员编辑平台配置包、检查后端、试跑草稿和发布修订。发布后修改包文件不改变已发布快照。
- Workbench 和 Runtime 各用自己的服务令牌。可读取执行器选择所需的修订元数据，但不能取得管理定义、编辑配置、发布修订或试跑草稿。未认证请求返回 401，消费者访问管理端点返回 403。
- Workbench 可按已知配置包 UUID 核验引用，只返回 `{id}` 或 404。Runtime 不能核验，两个消费者都不能列举配置包或读取其目录。
- 消费者按原尝试 ID 查询、重复提交或取消自己的执行，并按游标读取归一化事件页。跨角色查询、取消或读取事件和制品均返回 404，管理员令牌也只访问本角色的尝试。终态制品只读。

### 执行边界

#### 验收

- 平台接收显式输入快照；工作包 ID 和宿主文件路径不能代替文件内容。同 ID 同请求可重试，变更输入或目标返回 409。
- 启动回执丢失或 HTTP 服务重启时，按原 ID 核对原尝试，不重发任务。确认本轮终态和受管写入方停止后才可发布制品。详见[执行尝试规格](src/work/executor/SPEC.md)。
