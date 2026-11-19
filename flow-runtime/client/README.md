# 独立 Flow 客户端

`ursi-flow-client` 同时提供同步 Rust SDK `FlowClient` 和可执行文件 `ursi-flow`。两者通过本机 Unix socket 使用同一个 `ursi-flowd`。Runtime 使用 Node.js 22.19+，客户端无 Node 依赖。当前验收环境为 Linux。

独立使用 CLI 时，从 `flow-runtime/` 安装并启动 daemon：

```sh
npm ci && npm run build && npm install -g .
cargo install --locked --path client
ursi-flowd
```

在另一个终端从 `flow-runtime/` 运行：

```sh
ursi-flow config get
ursi-flow config set '{"executor":"local-pi","maxConcurrent":2}'
ursi-flow flow validate ordinary examples/ordinary
ursi-flow flow create ordinary examples/ordinary
ursi-flow run start ordinary '{"任务":"分析任务"}' review-001
ursi-flow run get review-001
ursi-flow run history review-001
ursi-flow run stop review-001
```

`flow list|get|update|delete` 管理已登记的包。`run list` 列出运行。`run start` 使用调用方当前工作目录，返回即表示已登记，模型或执行配置错误记在运行结果里。相同 Run ID、流程、工作目录和变量重提时返回已有记录。`run history` 返回管理状态 `job` 及已提交的运行、节点、路由和执行证据。中止的节点可能只有开始记录，不伪造 outcome。配置和流程包的修订对后续运行生效。

Rust 调用方要固定版本时，使用 `FlowClient::start_pinned(run_id, flow, cwd, variables, revision)`。`revision` 是整个 Flow 目录的发布修订。SDK 只发一次 `run.startPinned` 请求；daemon 在登记新 Run 前核对修订，过期返回 `io::ErrorKind::AlreadyExists`。响应丢失时，可用同一 ID 和原参数重试。即使目录已更新或 Flow 已删除，匹配原绑定也会返回已有 Run；更换修订、Flow、工作目录或变量会返回冲突。普通 `start` 和 CLI 的启动方式不变。

服务和客户端读取 `URSI_FLOW_HOME`，默认 `~/.ursi-flow`。该目录必须仅当前用户可访问。服务只面向同一账户的可信调用方，命令以该账户权限执行。一次连接承载一个不超过 4 MiB 的 JSON 请求，客户端关闭写端后读取 JSON 回复。模型凭据由 Pi 自身配置。`SIGTERM` 正常退出并停止活动运行。异常重启后不能核实的运行显示 `unknown`，不会自动重投。异常残留的 socket 应在核实原进程已退出后清理。

[Rust Server](../../workbench/server/README.md) 通过 `FlowClient` 访问自己启动的 daemon。要用 CLI 查询该实例，只需安装客户端，并将 CLI 的 `URSI_FLOW_HOME` 指向 Server 的 `<数据目录>/flow-runtime/`。此模式无需另行启动 `ursi-flowd`。其他 Rust 调用方可依赖 `client`，使用 `FlowClient::from_env()`、`start`、`history`、`stop`。方法是阻塞调用，异步服务应在阻塞任务中调用。本地停止针对受管进程组，不支持自行脱离该组的守护进程。流程历史与旧目录版本留在私有目录，当前无自动清理策略。

验收：`cargo build --locked --manifest-path client/Cargo.toml`，再运行 `python3 client/tests/acceptance.py`。测试为每次操作重新启动 CLI，验证停止真实命令和重启后的历史查询。
