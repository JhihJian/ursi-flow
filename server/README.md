# ursi-server

`ursi-server` 提供两个共用 Bearer 令牌的 HTTP 入口：`/api/v2` 从发布工作包到办理、交付和验收，`/api/v1` 管理 Flow 包、运行和配置。Server 不提供页面；现有 [Web 工作台](../web/README.md) 面向 Flow 管理。受信本地执行使用服务账户权限，只向可信操作者分发令牌。

## 安装与启动

以下命令从仓库根目录执行，需要 Linux 和 Rust 工具链。默认启用 Flow，另需 npm、Node.js 22.19+ 和本机 `ursi-flowd`：

```sh
(cd flow-runtime && npm ci && npm run build && npm install -g .)
command -v ursi-flowd
```

仅办理工作项、不使用 Flow 时，可跳过 daemon 安装并设置 `export URSI_FLOW_ENABLED=0`。通过服务环境注入令牌，本地用 Bash 启动时可静默输入：

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
| `URSI_FLOW_ENABLED` | `1` | `1` 启动本机 daemon 并挂载 v1；`0` 不启动 daemon，v2 的 Flow 动作不可执行。 |
| `URSI_FLOWD_BIN` | `PATH` 中的 `ursi-flowd` | 启用 Flow 时由 Server 启动的 daemon。Flow 包使用 Agent 节点时还需配置 `pi` 和模型。 |
| `URSI_AGENT_BIN` | 未设置 | v2 本地 Agent 使用的可信 Pi CLI 绝对路径；由部署者提供模型和认证配置。 |
| `URSI_WORK_SOURCES` | 未设置 | 私有来源配置 JSON 的绝对路径。启用后从本地 JSON 导出文件读取材料；未设置时不挂载来源接口。 |

`<URSI_DATA_DIR>/work/` 是服务账户的私有目录（`0700`）。Server 独占 `work.lock`，通过原子替换 `work.json` 保存定义版本、工作项、执行尝试、交付文本和验收记录。`<URSI_DATA_DIR>/flow-runtime/` 是 daemon 的私有目录，保存 Flow 包、配置、运行历史和 `runtime.sock`。这两个目录都不应作为工作区或静态文件目录公开。

沙箱适配器只连接管理员预配给单个工作项的独占 ACP 沙箱和卷。部署环境提供 `URSI_SANDBOX_CLIENT_BIN`、`URSI_ACP_URL`、`URSI_SESSION_TOKEN_FILE`、`URSI_SANDBOX_CWD`、`URSI_SANDBOX_ITEM_ID` 和 `URSI_SANDBOX_ALIAS`，并保持 `URSI_SESSION_TOKEN` 未设置。凭据文件权限、独占要求和收尾步骤见[预配说明](src/work/execute/SANDBOX.md)。未配置时不会回退到宿主机执行。

## API 索引

| 入口 | 用途与契约 |
| --- | --- |
| `/api/v1/flows`、`/api/v1/runs`、`/api/v1/flow-config` | [Flow 包、运行及配置](src/transport/SPEC.md)，仅在启用 Flow 时挂载。 |
| `/api/v2/resources`、`/api/v2/executors`、`/api/v2/packages` | [发布、查版本和停用定义](src/work/catalog/SPEC.md)。 |
| `/api/v2/items` | [派工、开始办理、提交交付、读取版本文件及验收](src/work/items/HTTP.md)。 |
| `/api/v2/items/{id}/attempts` | [发起、查询、取消及人工核实](src/work/execute/API.md)。Flow 动作使用固定目录修订（pinned）启动。 |
| `/api/v2/sources` | [从 JSON 文件列出材料并按固定动作派工](src/work/sources/README.md)。没有外部平台 SDK、平台授权或定制列表页面。 |

工作项文件接口只读回已提交的交付文本，不提供 PTY、浏览器或通用文件管理。[两阶段 HTTP 验收](tests/WORK-ACCEPTANCE.md) 使用真实 Pi CLI 配模拟模型，以及真实 Flow daemon 和 CLI。预配沙箱的自动测试仅验证模拟 CLI 的 ACP 契约，真实沙箱会话需单独验收。

## 检查服务与停机

在另一终端设置同一令牌，运行 `curl -fsS -H "Authorization: Bearer $URSI_API_TOKEN" http://127.0.0.1:8080/api/v2/items`。新数据目录应返回 `[]`；不带令牌时返回 401。此检查不依赖 Flow。

收到 `SIGINT`（Ctrl-C）或 `SIGTERM` 后，Server 停止 HTTP 服务。若启用了 Flow，还会等待自己的 daemon 退出。启用 Flow 时若已有 `runtime.sock`，Server 拒绝启动，不接管已有 socket 或进程。先核实原实例是否仍在运行，仅在确认它已退出后清理残留 socket。

要从 CLI 检查 Flow 数据，可按[客户端说明](../flow-runtime/client/README.md)安装 `ursi-flow`，将 CLI 的 `URSI_FLOW_HOME` 设为上述 `flow-runtime/` 子目录的绝对路径。daemon 在线时运行 `ursi-flow flow list` 即可。
