# ursi-executor-platform

独立 HTTP 服务，负责配置包、资源与执行器发布、后端检查、执行尝试和只读制品。Workbench 保存工作项与工作包，Flow Runtime 保存流程历史；两者通过平台 API 执行固定修订，无需挂载彼此的数据目录。

## 构建与启动

从仓库根目录运行，使用 Linux 和 Rust 工具链。在平台服务的环境中注入三个不同的 Bearer 令牌（非空可见 ASCII，不含空格）：

| 环境变量 | 用途 |
| --- | --- |
| `URSI_EXECUTOR_PLATFORM_ADMIN_TOKEN` | 平台管理页及管理 API。编辑配置包和资源、检查后端、预览草稿、发布与停用。 |
| `URSI_EXECUTOR_PLATFORM_WORKBENCH_TOKEN` | 发给 Workbench 服务，选择已发布版本、执行工作包。 |
| `URSI_EXECUTOR_PLATFORM_RUNTIME_TOKEN` | 发给 Runtime 服务，选择已发布版本、执行节点。 |
| `URSI_EXECUTOR_PLATFORM_DATA_DIR` | 平台私有目录，默认 `executor-platform-data`。生产使用固定绝对路径。 |
| `URSI_EXECUTOR_PLATFORM_LISTEN_ADDR` | 默认 `0.0.0.0:8081`。跨主机使用受保护的 HTTPS 入口。 |

```sh
cd executor-platform/server
cargo build --release --locked
./target/release/ursi-executor-platform
```

平台可在两个消费者均未启动时提供服务。配置模型、只读工具与适配器时，在**平台进程**配置 `URSI_PI_POLICY`、`URSI_PI_EXECUTOR_BIN` 或 `URSI_AGENT_BACKENDS`，详见[后端部署与检查](../../workbench/server/src/work/agent_backends/README.md)。[独立管理页](../web/README.md)使用管理员令牌；消费者只配置各自的服务凭证。

## API 与权限检查

平台地址下的 `/api/v2` 是服务 API。管理员用 `/patches/config`、`/directories` 编辑配置，用 `/agent-backends` 检查后端，在 `/resources` 和 `/executors` 发布版本，或用 `previewDefinition` 试跑。消费者只读执行器选择元数据，用 `PUT /executor-attempts/{id}` 提交固定 `executorRef`、UTF-8 `workInstruction` 和可选 `inputs` 快照。平台不接受 `workPatchId`。结果通过原 ID 查询和取消，制品按返回的 `artifactDirectoryId` 读取。

Runtime 启动 Run 前，以消费者令牌读取 `GET /node-executors/{id}/{revision}`。平台只确认启用的 Agent 修订，要求其后端已配置且声明 `flowOutcome`。内置 Pi 支持该能力，其他受管后端在实现 `runConfig.nodeContract` 和结果制品后，可在注册配置的 `capabilities` 中声明。

旧库切换见[离线迁移说明](../migration/README.md)。

以下请求直接访问平台，假定使用默认监听端口。新库的第一条请求返回 `[]`；第二条以同一消费者身份访问管理目录，应返回 403；去掉授权头应返回 401。

```sh
api=http://127.0.0.1:8081/api/v2
curl -fsS -H "Authorization: Bearer $URSI_EXECUTOR_PLATFORM_WORKBENCH_TOKEN" "$api/executors"
curl -sS -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $URSI_EXECUTOR_PLATFORM_WORKBENCH_TOKEN" "$api/agent-backends"
```

尝试归属按角色持久化。即使知道 ID，其他角色（包括管理员）也不能查询、取消该尝试或读取其制品，平台返回 404。这是服务角色之间的隔离，同一角色令牌的使用者共享该身份。

## 私有存储与重启

平台独占 `$URSI_EXECUTOR_PLATFORM_DATA_DIR/work.lock`，以 `platform.json` 保存元数据；包文件和制品保存在 `directories/`，每次执行的私有文件保存在 `executor-workspaces/`。存储根使用 `0700`，不得为符号链接、工作区或静态目录。Workbench 的 `work/` 与平台根必须分开，即使两服务不同时运行也不能互换。

收到 `SIGTERM` 或 `SIGINT` 后平台停止 HTTP 服务。停服后备份整个私有目录，恢复时沿用原角色配置和后端部署路径。重启后用原角色和原 `attemptId` 查询，不要另建尝试来补偿丢失的回执。已发布制品仍按原目录读取；健康状态重置为 `unchecked`，新试跑、发布前重新检查。重启平台不要求重启 Workbench 或 Runtime。

接口细节：[定义发布](../../workbench/server/src/work/catalog/HTTP.md)、[包记录](../../workbench/server/src/work/patches/HTTP.md)、[执行规格](src/work/executor/SPEC.md)。执行与查回由 [mod.rs](src/work/executor/mod.rs) 实现，输入快照与制品收集由 [files.rs](src/work/executor/files.rs) 实现。
