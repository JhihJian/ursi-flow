# ursi-server

`ursi-server` 为 Flow 包、运行和配置提供 `/api/v1`，也可从同一地址提供 Web 工作台。Server 启动本机 `ursi-flowd`，经 Unix socket 使用 Flow Runtime。流程包中的命令以服务账户权限运行，只向可信操作者分发令牌，并只运行受信的包。

## 安装与启动

以下命令从仓库根目录执行。需要 Linux、Rust 工具链和 npm。Runtime 需要 Node.js 22.19+，同时构建 Web 时使用 Node.js 24。执行 Agent 节点还需要服务账户可调用的 `pi` 及其模型配置。

```sh
(cd flow-runtime && npm ci && npm run build && npm install -g .)
command -v ursi-flowd
```

仅提供 API 时可跳过 Web 构建。要从同一地址访问工作台，执行：

```sh
(cd web && npm ci && npm run build)
export URSI_STATIC_ROOT="$PWD/web/dist"
```

通过服务环境注入非空 `URSI_API_TOKEN`。本地用 Bash 启动时可从终端静默输入：

```bash
read -rsp 'API token: ' URSI_API_TOKEN && printf '\n'
export URSI_API_TOKEN
cargo run --locked -p ursi-server
```

不需要预先启动 daemon。若安装目录不在服务账户的 `PATH`，请将 `URSI_FLOWD_BIN` 设为 `ursi-flowd` 的绝对路径。

## 配置

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `URSI_API_TOKEN` | 必填 | `/api` 的 Bearer 令牌。通过可信本机连接或 HTTPS 传输。 |
| `URSI_LISTEN_ADDR` | `0.0.0.0:8080` | HTTP 监听地址。 |
| `URSI_DATA_DIR` | `data` | 持久化根目录。子目录 `flow-runtime/` 是 daemon 的私有目录，保存包、配置、运行历史和 `runtime.sock`。 |
| `URSI_FLOWD_BIN` | `PATH` 中的 `ursi-flowd` | Server 启动的 daemon 可执行文件。 |
| `URSI_WORKSPACE_DIR` | 当前目录 | HTTP 请求中的工作区别名 `default` 对应的本地项目目录。 |
| `URSI_STATIC_ROOT` | 未配置 | 静态资源根目录，例如 `web/dist`。省略时只提供 API。 |

## 检查服务与停机

在另一终端设置同一令牌，运行 `curl -fsS -H "Authorization: Bearer $URSI_API_TOKEN" http://127.0.0.1:8080/api/v1/flows`。新数据目录应返回 `[]`；不带令牌时返回 401。已配置静态目录时，打开 `http://127.0.0.1:8080/`，在工作台输入令牌本身。完整接口见 [HTTP 规格](src/transport/SPEC.md)。

收到 `SIGINT`（Ctrl-C）或 `SIGTERM` 后，Server 停止 HTTP 服务并等待自己的 daemon 退出。daemon 停止活动运行，正常退出后可沿用同一数据目录启动。启动时若发现已有 `runtime.sock`，Server 拒绝启动，不接管已有 socket 或进程。先核实原实例是否仍在运行；仅在确认它已退出后清理残留 socket。

要从 CLI 检查同一份数据，可按 [客户端说明](../flow-runtime/client/README.md) 安装 `ursi-flow`，将 CLI 的 `URSI_FLOW_HOME` 设为上述 `flow-runtime/` 子目录的绝对路径。Server 在线时直接运行 `ursi-flow flow list` 即可。
