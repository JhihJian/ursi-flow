---
parent: ../SPEC.md
depends-on:
  - ../../flow-runtime/client/SPEC.md
  - ../../executor-platform/server/SPEC.md
references:
  - ../../docs/design/workbench/SERVER-FLOW.md
  - ../../docs/design/workbench/SERVER-WORK-MANAGEMENT.md
  - README.md
---

# ursi-server

## 功能意图

Server 通过 `/api/v2` 管理工作清单、工作包、业务目录、生成器和 MCP 资源来源。它以 Workbench 消费者身份向独立执行器平台选版和提交尝试，平台独占配置包、执行器及资源定义的管理权。`/api/v1` 提供可选的 Flow 管理入口：Server 管理本机 `ursi-flowd` 子进程，Flow Runtime 持有 Flow 包修订、运行配置和节点历史。数据边界见 [Server v2 设计](../../docs/design/workbench/SERVER-WORK-MANAGEMENT.md)。

## 关键功能与验收

### 业务工作包与平台执行

#### 验收

- [工作清单](src/work/worklist/SPEC.md)可独立增删改查。通过[平台 MCP](src/work/mcp/SPEC.md)选择资源并保存配方后，可按请求生成工作包。删除清单项时保留文件与生成来源。
- [工作包生成器](src/work/generation/GENERATORS-HTTP.md)按不可变修订发布。试运行或关联工作项的运行都以统一请求指定修订，运行状态和结果可独立于 Flow 查询。
- [工作包](src/work/patches/SPEC.md)返回本地 `directoryId`，可通过[目录接口](src/work/directories/SPEC.md)读写业务文件。独立创建的业务目录无需绑定包。配置包文件只在平台编辑。
- 可读取执行器选择所需的修订元数据，按固定 `executorRef: {id, revision}` 和业务输入快照执行。Workbench 只能查询、取消本角色的尝试，通过 `platform-artifact-{attemptId}` 只读访问已发布制品。该句柄不出现在业务目录列表。

### HTTP 管理入口

#### 验收

- 启用 Flow 时，`/api/v1` 提供包校验与增删查改、启动与停止运行、运行详情与历史、运行配置读写。CLI 连接同一 socket 时能读回 HTTP 提交的更改。
- `/api/v2/platform-env` 可列出平台变量名称、新增、替换和删除值。值存于私有工作存储，不在管理响应中返回。平台变量独立于宿主进程环境。
- Workbench 不挂载配置包、资源发布、后端检查、执行器发布或停用接口，也不代理草稿试跑。平台管理操作使用独立的平台管理员入口。
- 未经认证的 API 请求返回 401。v1 运行请求只接受 `default` 工作区，目录由部署者配置。
- Server 不提供页面或静态资源。非 API 路径返回 404。旧派工接口 `/api/v2/items`、`/api/v2/packages`、`/api/v2/sources` 均未挂载，已认证请求返回 404。

### 子进程与持久数据

#### 验收

- `URSI_API_TOKEN`、`URSI_EXECUTOR_PLATFORM_URL` 和 `URSI_EXECUTOR_PLATFORM_TOKEN` 缺一项即启动失败，关闭 Flow 也不例外。后者是 Workbench 的平台消费者令牌。默认启动配置的 daemon 并等待就绪；已有 socket 时拒绝启动。`URSI_FLOW_ENABLED=0` 时不启动 daemon、不挂载 v1，v2 仍可用。
- 旧存储在取得独占锁后执行不可逆迁移。派工单、模板和尝试级快照被移除，仅清理旧制品及快照独占且已登记的目录。清单与工作包继续在本地可用。旧配置包与执行器尝试的制品目录不列出、按原 ID 不可读写；旧平台记录不会自动导入独立平台。备份要求见[升级说明](README.md#旧数据升级)。
- 收到 `SIGTERM` 或 `SIGINT` 后，HTTP 监听和本实例启动的 daemon 均退出。以同一数据目录重启，可从私有 `work/` 查回工作清单、工作包和生成器修订；启用 Flow 时还能从独立的 `flow-runtime/` 查回 Flow 包和运行历史。
