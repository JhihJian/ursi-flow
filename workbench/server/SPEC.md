---
parent: ../SPEC.md
depends-on:
  - ../../flow-runtime/client/SPEC.md
references:
  - DESIGN.md
  - DESIGN-v2.md
  - README.md
---

# ursi-server

## 功能意图

Server 通过 `/api/v2` 管理工作清单、包目录、平台 MCP 服务及版本化定义。`/api/v1` 提供可选的 Flow 管理入口：Server 管理本机 `ursi-flowd` 子进程，Flow Runtime 持有 Flow 包修订、运行配置和节点历史。数据边界见 [Server v2 设计](DESIGN-v2.md)。

## 关键功能与验收

### 工作清单、包与独立定义

#### 验收

- [工作清单](src/work/worklist/SPEC.md)可独立增删改查。通过[平台 MCP](src/work/mcp/SPEC.md)选择资源并保存配方后，可按请求生成工作包。删除清单项时保留文件与生成来源。
- [工作包与配置包](src/work/patches/SPEC.md)返回各自的 `directoryId`，按 ID 通过[目录接口](src/work/directories/SPEC.md)读写文件。独立创建的虚拟目录无需绑定包。
- [资源与执行器](src/work/catalog/SPEC.md)按修订发布和读取。执行器固定引用资源修订，停用对象后历史修订仍可读取。

### HTTP 管理入口

#### 验收

- 启用 Flow 时，`/api/v1` 提供包校验与增删查改、启动与停止运行、运行详情与历史、运行配置读写。CLI 连接同一 socket 时能读回 HTTP 提交的更改。
- `/api/v2/platform-env` 可列出平台变量名称、新增、替换和删除值。值存于私有工作存储，不在管理响应中返回。平台变量独立于宿主进程环境。
- 未经认证的 API 请求返回 401。v1 运行请求只接受 `default` 工作区，目录由部署者配置。
- Server 不提供页面或静态资源。非 API 路径返回 404。旧派工接口 `/api/v2/items`、`/api/v2/packages`、`/api/v2/sources` 均未挂载，已认证请求返回 404。

### 子进程与持久数据

#### 验收

- 缺少 `URSI_API_TOKEN` 时启动失败。默认启动配置的 daemon 并等待就绪；已有 socket 时拒绝启动。`URSI_FLOW_ENABLED=0` 时不启动 daemon、不挂载 v1，v2 仍可用。
- 旧存储在取得独占锁后执行不可逆迁移。派工单、模板和尝试级快照被移除，仅清理旧制品及快照独占且已登记的目录。清单、工作包、配置包及其文件、资源和执行器定义保持可读。备份要求见[升级说明](README.md#旧数据升级)。
- 收到 `SIGTERM` 或 `SIGINT` 后，HTTP 监听和本实例启动的 daemon 均退出。以同一数据目录重启，可从私有 `work/` 查回工作清单、包与定义；启用 Flow 时还能从独立的 `flow-runtime/` 查回 Flow 包和运行历史。
