# ursi-server

`ursi-server` 是 ursi-flow 的 HTTP、SSE、MCP 和静态资源入口。业务模型与持久化边界在 `flow-core/`，沙箱接入实现位于 `sandbox-access/`。本地启动不需要 Docker、Gateway 或模型凭据。

## 配置

使用 workspace 根目录构建。所有环境变量均可省略，默认监听 `0.0.0.0:8080`，数据目录为当前目录下的 `data/`，不启用静态资源和 Gateway。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `URSI_LISTEN_ADDR` | `0.0.0.0:8080` | HTTP 监听地址，例如 `0.0.0.0:8080` |
| `URSI_DATA_DIR` | `./data` | SQLite 文件和内容目录的根目录 |
| `URSI_STATIC_ROOT` | 未配置 | 静态资源目录，未配置时静态兜底返回 404 |
| `URSI_GATEWAY_URL` | 未配置 | Gateway HTTP(S) 根地址，必须与 key 同时配置 |
| `URSI_GATEWAY_KEY` | 未配置 | Gateway Bearer key，不写入日志；必须与 URL 同时配置 |
| `URSI_ACP_BINDINGS_DIR` | 未配置 | 管理员私有 ACP 运行身份目录，每个运行读取 `<run_id>.json` |

Gateway URL 不能包含用户信息、query 或 fragment。配置 URL 和 key 后，server 会使用 `sandbox-access` 的 Gateway v1 客户端；没有 Gateway 时仍可启动并处理配置、查询和审批类操作，需要远端沙箱的执行请求返回 `503 sandbox_unavailable`。当前生产装配只接受显式 Pi 执行器和 ACP 绑定，脚本执行、文件产物回收以及完整 Channel 端点绑定尚未由 server 装配完成。

ACP 绑定文件由管理员放入 `URSI_ACP_BINDINGS_DIR`，文件名为 `<run_id>.json`，包含 `sandbox_id`、内部 `session` 地址、专用 token 和模型名。文件目录及祖先应仅允许可信用户写入，具体字段和实时端点核验见 [ACP 接入说明](../sandbox-access/ACP.md)。入站 API 不接收 token 或内部地址。从旧版升级时，请先按 [Runtime ACP 迁移说明](REAL-RUNTIME-ACP.md) 移除全局 ACP 环境变量并显式迁移角色。旧快照可查询，但不能用新身份启动。

## 启动

```bash
cargo build -p ursi-server
URSI_LISTEN_ADDR=0.0.0.0:8080 \
URSI_DATA_DIR="$PWD/.localdata/server" \
./target/debug/ursi-flow
```

从另一终端运行 `curl -fsS http://127.0.0.1:8080/api/v1/workflows` 可检查业务 API。若只需要离线服务，可省略 Gateway 和 ACP 环境变量，用 `cargo run --locked -p ursi-server --no-default-features --bin ursi-flow` 启动不编入接入库的构建；该构建若收到 Gateway 配置会拒绝启动。

要管理沙箱，先按 [Gateway 使用说明](../ursi-sandbox/gateway/README.md) 启动独立进程，再在 **默认 feature 构建**的 Server 环境中设置同一份 key：

```bash
export URSI_GATEWAY_URL=http://127.0.0.1:8899
export URSI_GATEWAY_KEY="$(< /private/gateway-key)"
export URSI_ACP_BINDINGS_DIR=/private/ursi/acp-bindings
export URSI_DATA_DIR="$PWD/.localdata/server"
cargo run --locked -p ursi-server --bin ursi-flow
```

server 启动时创建数据目录和各域 SQLite/内容存储，绑定成功后报告就绪。收到 Ctrl-C 或 SIGTERM 后停止 HTTP、后台扫描和资源收尾任务。`URSI_GATEWAY_URL` 与 `URSI_GATEWAY_KEY` 只配置一项会在启动前报错。

## 无 Gateway 的独立验收

从 workspace 根目录运行 `scripts/ci/run-workspace-isolation.sh server`。脚本将 Server workspace 三个包、清单、锁文件和 v1 协议制品复制到临时目录。它还复制公共 SDK（`ursi-sandbox/client` 的清单和 `src/`，以及继承 workspace 字段所需的上层清单）。只有 `sandbox-access` 可直接依赖 SDK，Gateway 与 Runtime 实现不参与 Server 构建。隔离脚本检查依赖边界，构建并测试启用和关闭接入层的两个版本。需要 Rust、Python 3、rsync 和本地回环网络；不需要 Gateway 源码、Docker、SSH 服务或模型凭据。可用 `CI_REPORT_DIR` 指定报告目录，依赖已缓存时可加 `CARGO_NET_OFFLINE=true`。

| 验收入口 | 外部替身 | 实际验证的 Server 行为 |
| --- | --- | --- |
| `gateway_consumer` | httptest HTTP 服务 | 生产装配发出创建、查询和释放请求，按协议区分受理、就绪、未知及释放完成 |
| `acp_migration` | 无远端服务，使用临时 SQLite 与旧版数据 | 拒绝全局身份、旧快照不重放、角色迁移后创建新运行 |
| `remote_execution` | HTTP 和 ACP WebSocket 对端 | 身份绑定、文本任务、取消和结果未知时不重发 |
| `server_only_execution`（lib 测试） | 可注入的脚本工作区 | 运行引擎调度、先归档再释放、失败后保留输出；部分归档可在当前进程内重试 |
| `local_artifacts` | 无，使用临时 SQLite 和内容目录 | 按 run 或稳定 ID 查询实际归档的产物、重启读回和内容损坏处理 |

生产启动没有 mock 开关。未配置执行通道的脚本请求返回 503，不产生执行尝试；以上测试不验证真实容器、远端文件传输或模型行为。

## 单独运行测试

从 workspace 根目录运行：

```bash
cargo test -p flow-core
cargo test -p sandbox-access
cargo test -p ursi-server
cargo test --locked -p ursi-server --no-default-features
cargo test --locked -p ursi-server --test gateway_consumer
cargo test --locked -p ursi-server --test remote_execution
cargo clippy -p ursi-server --all-targets --all-features -- -D warnings
```

独立检出平台时，用 `URSI_GATEWAY_V1_CONTRACT_DIR` 指向同版本的 [Gateway v1 制品](../contracts/gateway/v1/README.md)。当前版本正式 Runtime 的独立核验入口及历史记录的适用范围见 [验收差异](REAL-RUNTIME-ACP.md#验收差异)。正式镜像和真实模型另按 [Runtime 构建](../ursi-sandbox/runtime/README.md) 与 [独立客户端验收](../ursi-sandbox/client/README.md) 准备。
