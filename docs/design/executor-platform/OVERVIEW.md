# 执行器管理平台

Workbench 和 Flow Runtime 通过同一个 HTTP 平台执行固定修订。`executorRef: {id, revision}` 指向同一份冻结配置和后端绑定，各消费者使用自己的服务凭证。平台启动受管 worker，经本机 ACP v2 stdio 执行 Agent 任务。

## 职责与入口

| 模块 | 拥有的数据和操作 | 用户入口 |
| --- | --- | --- |
| 执行器平台 | 配置包、资源、执行器修订、后端登记与检查、草稿试跑、尝试和只读制品 | 独立管理页负责编辑、检查、试跑、发布与停用。 |
| Workbench | 工作清单、业务工作包与材料、生成来源 | 从工作包选择已发布修订直接执行，或选择 Flow 和执行器后启动流程。 |
| Flow Runtime | Flow 修订和节点指令、运行记录、结果与变量校验、路由、停止与恢复 | 独立控制台与 Workbench 内嵌入口使用同一运行契约。命令节点、子 Flow 和图控制由 Runtime 调度。 |

管理员在配置包中编辑 `AGENTS.md`、`skills/` 和 `mcp.json`。试跑只冻结本次草稿；发布将快照和 ACP 后端绑定固定在修订上。Workbench 的业务目录与平台私有存储分开。

## 一次运行怎样传递

1. 工作包直跑时，Workbench 将指令、固定修订和显式输入快照交给平台。启动 Flow 时，Workbench 把执行器引用交给 Runtime；独立控制台可提交同样的参数。Runtime 在委派 Agent 节点前持久化节点执行与新 `attemptId` 的关联。循环再次进入同一节点使用新 ID，同一次请求丢失回执时用原 ID 查回。
2. 平台准备该次私有工作区，按冻结配置和原绑定启动 worker。worker 建立新会话，只提交一次任务，维护状态和归一化事件。调用方按原 ID 查询或取消。[ACP 执行契约](ACP-PROFILE.md)说明提交、终态和回收条件。
3. 终态确认且受管写入方停止后，平台收集只读制品。Flow 节点接收本次 `outcomes` 和 `variables`，由适配器提供 `submit_flow_outcome` 并生成 `flow-outcome.json`。Runtime 按[节点结果契约](../../../apps/ursi-flow/docs/flow-spec.md)复验后才选边。`unverified`、缺少结果或结果非法都不推进路由，也不触发换后端重跑。
4. 原服务角色可直接通过平台 API 按游标读取归一化事件页。事件页用于查看已采集的轨迹，终态与结果仍以尝试及制品接口为准。

## 部署与历史

平台与受管 Agent 在同一主机和文件系统上部署。业务输入由调用方作为文件快照提交；跨节点传递制品时由 Runtime 选择并显式传入。工作包 ID、宿主路径、后端命令和凭据都不随任务发送给平台。尝试、事件和制品按平台服务角色授权。

ACP 切换保留原平台已完成的结果与制品。旧 MCP 修订保留为历史，新执行须发布并选择 ACP 修订。独立的 `ursi-flow-executor-mcp` 启停整条 Flow 的 Runtime Run，留在平台之外，其去留由独立使用方审计决定。业务 MCP 工具访问仍由部署策略约束。

操作入口：[平台部署与 API](../../../executor-platform/server/README.md)、[Workbench 接入](../../../workbench/EXECUTOR-INTEGRATION.md)、[ACP 后端设计与切换](ACP-BACKEND.md)。
