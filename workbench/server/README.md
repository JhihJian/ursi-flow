# ursi-server

`ursi-server` 提供两个共用 Bearer 令牌的 HTTP 入口：`/api/v2` 管理工作清单、目录、包、平台 MCP 服务及版本化定义，`/api/v1` 管理 Flow 包、运行和配置。[Web 工作台](../web/README.md) 由独立的静态服务提供。受信本地 Flow 使用服务账户权限，只向可信操作者分发令牌。

## 旧数据升级

**迁移不可逆。首次用新版打开旧数据目录前，停止旧实例，备份整个 `$URSI_DATA_DIR/work/`，包括 `work.json` 和目录文件。** Server 取得 `work.lock` 后自动迁移，关闭 Flow 也会触发：

- 删除旧派工单 `items`（含执行尝试、交付文本与验收记录）、派工模板 `catalog.packages` 和尝试级配置快照 `configPackageSnapshots`。旧单不会转换为 `/work-items` 清单项。
- 仅清理旧制品与配置快照引用的、已登记且无其他引用的目录及其文件。现有工作清单、工作包、配置包及其目录、资源和执行器定义、平台 MCP 服务均保留。独立的 Flow Runtime 数据不受影响。
- 目录清理失败时服务拒绝启动。修复存储问题后可重试；要恢复旧派工数据，须停服并用升级前的完整备份配合旧版程序恢复。仅回退程序或只还原 `work.json` 无法找回已删除的文件。

## 安装与启动

以下命令从 `workbench/` 执行，需要 Linux 和 Rust 工具链。默认启用 Flow，另需 npm、Node.js 22.19+ 和本机 `ursi-flowd`：

```sh
(cd ../flow-runtime && npm ci && npm run build && npm install -g .)
command -v ursi-flowd
```

只使用 v2 时，可跳过 daemon 安装并设置 `export URSI_FLOW_ENABLED=0`。通过服务环境注入令牌，本地用 Bash 启动时可静默输入：

```bash
read -rsp 'API token: ' URSI_API_TOKEN && printf '\n'
export URSI_API_TOKEN
cargo run --locked -p ursi-server
```

## 部署配置与存储

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `URSI_API_TOKEN` | 必填 | `/api` 的 Bearer 令牌，只含非空、无空格的可见 ASCII 字符。通过可信本机连接或 HTTPS 传输。 |
| `URSI_LISTEN_ADDR` | `0.0.0.0:8080` | HTTP 监听地址。 |
| `URSI_DATA_DIR` | `data` | 服务账户控制的持久化根目录，工作数据与 Flow 数据分开存放。 |
| `URSI_WORKSPACE_DIR` | 当前目录 | 已存在的受信本地项目目录，对应工作区别名 `default`。 |
| `URSI_FLOW_ENABLED` | `1` | `1` 启动本机 daemon 并挂载 v1；`0` 仅提供 v2。 |
| `URSI_FLOWD_BIN` | `PATH` 中的 `ursi-flowd` | 启用 Flow 时由 Server 启动的 daemon。Flow 包使用 Agent 节点时还需配置 Pi 和模型。 |

`$URSI_DATA_DIR/work/` 是服务账户的私有目录（`0700`）。Server 独占 `work.lock`，通过原子替换 `work.json` 保存业务记录，包内文件存于独立的虚拟目录。`$URSI_DATA_DIR/flow-runtime/` 是 daemon 的私有目录，保存 Flow 包、配置、运行历史和 `runtime.sock`。这两个目录都不应作为工作区或静态文件目录公开。

## API 索引

| 入口 | 用途与契约 |
| --- | --- |
| `/api/v1/flows`、`/api/v1/runs`、`/api/v1/flow-config` | [Flow 包、运行及配置](src/transport/SPEC.md)，仅在启用 Flow 时挂载。 |
| `/api/v2/work-items` | [工作清单](src/work/worklist/SPEC.md)：增删改查、按类别与状态筛选、按保存的配方生成工作包。 |
| `/api/v2/mcp-servers` | [平台 MCP 服务](src/work/mcp/PLATFORM.md)：登记、发现资源。在页面登记端点并选择凭据即可浏览资源；使用资源生成工作包另需 Python 隔离环境。 |
| `/api/v2/directories` | [虚拟目录](src/work/directories/HTTP.md)：创建目录并按目录 ID 读写文件。 |
| `/api/v2/patches/work`、`/api/v2/patches/config` | [工作包与配置包](src/work/patches/HTTP.md)：创建、查询包记录，修改工作包的当前归属。 |
| `/api/v2/resources`、`/api/v2/executors` | [资源与执行器定义](src/work/catalog/HTTP.md)：发布、查版本和停用。 |

## 检查服务与停机

在另一终端设置同一令牌，运行 `curl -fsS -H "Authorization: Bearer $URSI_API_TOKEN" http://127.0.0.1:8080/api/v2/work-items`。新数据目录应返回 `[]`；不带令牌时返回 401。此检查不依赖 Flow。

收到 `SIGINT`（Ctrl-C）或 `SIGTERM` 后，Server 停止 HTTP 服务。若启用了 Flow，还会等待自己的 daemon 退出。启用 Flow 时若已有 `runtime.sock`，Server 拒绝启动，不接管已有 socket 或进程。先核实原实例是否仍在运行，仅在确认它已退出后清理残留 socket。

要从 CLI 检查 Flow 数据，可按[客户端说明](../../flow-runtime/client/README.md)安装 `ursi-flow`，将 CLI 的 `URSI_FLOW_HOME` 设为上述 `flow-runtime/` 子目录的绝对路径。daemon 在线时运行 `ursi-flow flow list` 即可。
