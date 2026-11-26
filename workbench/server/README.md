# ursi-server

`ursi-server` 在 `/api/v2` 管理工作清单、生成器、工作包、业务目录和 MCP 资源来源，统一使用 Workbench API 令牌。[Web 工作台](../web/README.md) 由独立的静态服务提供，只向可信操作者分发 API 令牌。

Workbench 是[执行器平台](../../executor-platform/server/README.md)的消费者：可选择已发布修订、执行工作包、查回或取消自己的尝试并读取制品。配置包编辑、资源与执行器发布、草稿试跑和后端检查均在[平台管理页](../../executor-platform/web/README.md)操作，Workbench 不提供这些管理入口。

## 旧数据升级

**迁移不可逆。首次用新版打开旧数据目录前，停止旧实例，备份整个 `$URSI_DATA_DIR/work/`，包括 `work.json` 和目录文件。** Server 打开业务库并取得 `work.lock` 后即可能执行旧派工清理。即使随后因平台配置缺失而启动失败，也不要假定旧库未经更改：

- 删除旧派工单 `items`（含执行尝试、交付文本与验收记录）、派工模板 `catalog.packages` 和尝试级配置快照 `configPackageSnapshots`。旧单不会转换为 `/work-items` 清单项。
- 仅删除上述派工尝试制品或快照独占且已登记的目录及其文件，不扫描无主目录。现有清单、工作包、业务目录和 MCP 来源仍可用。
- 目录清理失败时服务拒绝启动。修复存储问题后可重试；要恢复旧派工数据，须停服并用升级前的完整备份配合旧版程序恢复。仅回退程序或只还原 `work.json` 无法找回已删除的文件。

**平台拆分不会自动导入旧库。** 旧 `configPatches` 引用的配置目录和 `executorAttempts` 引用的制品目录保留在磁盘上，但从 Workbench 列表隐藏，按原 ID 读写均返回 404。不要把 `work/` 指作平台根，也不要将 `work.json` 改名为 `platform.json`。切换前在独立平台核对所需配置包 ID、执行器修订和冻结快照，验证原有引用后再恢复业务执行。

## 安装与启动

以下命令从 `workbench/` 执行，需要 Linux 和 Rust 工具链。先独立部署执行器平台，并取得分配给 Workbench 的消费者令牌。跨主机部署用 HTTPS，令牌通过服务环境注入。用 Bash 本地检查时可静默输入：

```bash
read -rsp 'API token: ' URSI_API_TOKEN && printf '\n'
read -rsp 'Workbench consumer token: ' URSI_EXECUTOR_PLATFORM_TOKEN && printf '\n'
export URSI_API_TOKEN URSI_EXECUTOR_PLATFORM_TOKEN
export URSI_EXECUTOR_PLATFORM_URL=http://127.0.0.1:8081
cargo run --locked -p ursi-server
```

## 部署配置与存储

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `URSI_API_TOKEN` | 必填 | `/api` 的 Bearer 令牌，只含非空、无空格的可见 ASCII 字符。通过可信本机连接或 HTTPS 传输。 |
| `URSI_EXECUTOR_PLATFORM_URL` | 必填 | 执行器平台的 HTTP(S) origin，如 `http://127.0.0.1:8081`。不附 `/api/v2`、用户信息、查询串或片段。 |
| `URSI_EXECUTOR_PLATFORM_TOKEN` | 必填 | Workbench 出站请求使用，对应平台侧 `URSI_EXECUTOR_PLATFORM_WORKBENCH_TOKEN`。与入站 API 令牌分开，不发给浏览器。 |
| `URSI_LISTEN_ADDR` | `0.0.0.0:8080` | HTTP 监听地址。 |
| `URSI_DATA_DIR` | `data` | 服务账户控制的持久化根目录。 |


平台 URL 和 Workbench 消费者令牌缺一项或格式无效时，Server 启动失败，不回退到本地平台。

`$URSI_DATA_DIR/work/` 是服务账户的私有目录（`0700`）。Server 独占 `work.lock`，通过原子替换 `work.json` 保存业务记录，工作包文件存于 `directories/`。平台另用私有的 `$URSI_EXECUTOR_PLATFORM_DATA_DIR` 保存 `platform.json`、配置文件和执行制品。两服务不能共用或互换存储根，即使另一服务已停止。上述私有目录都不应作为工作区或静态文件目录公开。

## API 索引

| 入口 | 用途与契约 |
| --- | --- |
| `/api/v2/work-items` | [工作清单](src/work/planning/SPEC.md)：增删改查、按类别与状态筛选。 |
| `/api/v2/mcp-servers` | [平台 MCP 服务](src/work/mcp/PLATFORM.md)：登记、发现资源。在页面登记端点并选择凭据即可浏览资源；使用资源生成工作包另需 Python 隔离环境。 |
| `/api/v2/directories` | [业务目录](src/work/directories/HTTP.md)：独立建目录或按工作包的 `directoryId` 读写文件。列表不含平台目录。 |
| `/api/v2/patches/work` | [工作包](src/work/patches/HTTP.md)：创建、查询、修改当前归属。配置包接口仅在平台。 |
| `/api/v2/executors`、`/api/v2/executor-attempts/{id}` | 读取选版元数据，按固定修订执行，查询或取消 Workbench 的尝试。用终态返回的 `platform-artifact-{attemptId}` 目录句柄只读访问制品。 |

## 检查服务与停机

在另一终端设置同一令牌，运行 `curl -fsS -H "Authorization: Bearer $URSI_API_TOKEN" http://127.0.0.1:8080/api/v2/work-items`。新数据目录应返回 `[]`；不带令牌时返回 401。

收到 `SIGINT`（Ctrl-C）或 `SIGTERM` 后，Server 停止 HTTP 服务。
