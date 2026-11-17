# Pi 会话服务

`ursi-session-service` 在沙箱内提供 ACP JSON-RPC WebSocket，管理每个会话的长期 Pi RPC 进程。执行协议采用 [AGENT-CONTRACT.md](../../AGENT-CONTRACT.md)。服务以 root 运行，Pi 与工具降权为 UID/GID 1000。Linux 内核需要支持 `/proc`、subreaper 和 pidfd（5.3 及以上），Docker seccomp 需要允许相关系统调用。

## 启动与配置

在仓库根目录构建：

```sh
cargo build --release -p ursi-session-service
```

将 `target/release/ursi-session-service` 放入 bundle 的 `bin/`。监督器直接启动该二进制，默认监听 `0.0.0.0:8765`。`GET /healthz` 返回 `200 ok`，表示服务配置和状态恢复已完成。Runtime 总体健康检查还需单独确认 SSH 就绪。

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `URSI_SESSION_CONFIG_DIR` | `/run/ursi/config` | 管理员只读配置目录 |
| `URSI_WORKSPACE_ROOT` | `/ursi/workspace` | 已存在的工作区根目录 |
| `URSI_SESSION_STATE_DIR` | `/ursi/workspace/.ursi-state` | root 0700 状态目录 |
| `URSI_SESSION_RUNTIME_DIR` | `/run/ursi/sessions` | 工作区外的临时 Pi 配置与 HOME |
| `URSI_PI_BIN` | `/usr/local/bin/pi` | 绝对可执行路径，Pi 1.5.0 |
| `URSI_SESSION_BIND` | `0.0.0.0:8765` | HTTP/WebSocket 监听地址 |
| `URSI_SESSION_TASK_TIMEOUT_SECS` | `1800` | 单次 prompt 总期限，范围 1 至 86400 秒 |

配置目录包含：

- `session-token`：至少 32 字符的 Bearer token，可带结尾换行。
- `session.json`：`{"provider":"provider-name","model":"model-id"}`。
- `pi/models.json`：Pi 模型配置。
- `pi/auth.json`：可选 Pi 提供方凭据。

生产配置目录或 `session-token` 文件必须归 root 所有，且 group/other 权限均为零。服务读取配置后，向每会话的 0700 临时目录复制 `models.json`、可选 `auth.json`，并写入关闭重试和压缩的设置文件，文件权限为 0600。`session-token` 始终由服务保留。关闭、取消、失败与服务恢复时清理临时配置。

生产启动将 workspace 顶层设置为 root:1000、01770。agent 组可创建项目目录，sticky 位保护 root 的 `.ursi-state` 免遭改名或删除。已有项目及文件所有权保持原样。bootstrap 再次启动时应保留 `.ursi-state` 的 root 所有权，项目目录的权限初始化应排除该目录。状态目录位于 workspace 内时，必须是顶层直接子目录。普通用户运行的测试服务使用当前 UID/GID，其权限隔离仅用于确定性测试。

Pi 使用独立 HOME、TMPDIR、`PI_CODING_AGENT_DIR`。环境经 `env_clear` 后仅设置固定 PATH、上述目录、`LANG=C.UTF-8` 与 Pi 离线、禁遥测、禁版本检查开关。提供方凭据通过 Pi 配置文件使用，管理员配置应使用文件中的实际凭据。宿主的 API key、代理变量、`NODE_OPTIONS` 和服务 token 环境变量均不会传入 Pi。

启动参数为：

```text
--mode rpc --no-session --no-extensions --no-mcp --no-skills
--no-context-files --no-approve --no-prompt-templates --no-themes
--offline --provider <provider> --model <model>
```

`--offline` 关闭目录刷新等自动网络活动，显式模型请求仍可联网。首次 prompt 前，服务按 RPC ID 确认 `set_auto_retry(false)` 和 `set_auto_compaction(false)` 成功。

## WebSocket API

连接 `GET /acp`，携带 `Authorization: Bearer <session-token>`。任何 Origin、query string 均返回 403，缺失或错误身份返回 401。请求格式为 JSON-RPC 2.0，ID 接受整数或最长 128 字节的字符串。

每次连接先调用 `initialize`，参数为 `{"protocolVersion":1,"clientCapabilities":{}}`。结果包含协议版本、`agentInfo` 与 `agentCapabilities`，其中 `loadSession:false`，输入支持文本。

| 方法 | 参数 | 结果 |
| --- | --- | --- |
| `session/new` | `{"cwd":"/ursi/workspace/repo","mcpServers":[]}` | `{"sessionId":"UUID"}` |
| `session/prompt` | `{"sessionId":"UUID","prompt":[{"type":"text","text":"任务"}]}` | 最终停止后返回 `{"stopReason":"end_turn"}` 或 `cancelled` |
| `session/cancel` | 通知，`{"sessionId":"UUID"}` | 通知无响应，对应 prompt 等清理完成后返回 cancelled |
| `_ursi/session/status` | `{"sessionId":"UUID"}` | `{"sessionId":"UUID","state":"running","pid":123}` |
| `_ursi/session/close` | `{"sessionId":"UUID"}` | 确认回收后返回 `{}`，重复 close 保留成功或清理失败结果 |

`cwd` 必须是绝对路径，canonicalize 后为 workspace 内的已有目录，且位于 state 目录之外。创建会话时固定目录句柄并保存请求路径和规范路径。每轮 prompt（包括复用 Pi）重新检查两条路径的规范化结果、句柄当前路径以及设备号/inode。路径被改名、替换成新目录或重定向时，拒绝本轮请求，清理旧 Pi，状态进入 interrupted。非空 MCP 配置、图片与其他 prompt block 返回参数错误。

启动监督器时通过固定句柄 `fchdir`，Pi 继承该目录，减少校验与启动之间再次解析路径的竞态。校验保证的是服务拒绝检查时已被篡改的请求工作目录。Pi 工具仍会以绝对 cwd 字符串访问文件，检查后的并发替换也可能影响工具路径解析。Bash 对整个容器的访问由 Linux 权限和容器隔离决定，这些 cwd 检查不提供文件系统沙箱。

`session/update` 为通知，`params` 包含 `sessionId` 与 `update`。文本映射为 `agent_message_chunk`，工具执行映射为 `tool_call`、`tool_call_update`，保留 `toolCallId`、title、`in_progress/completed/failed` 和 ACP 文本 content。

错误码：JSON 解析失败 `-32700`，非法 JSON-RPC 请求 `-32600`，未知方法 `-32601`，参数错误 `-32602`，初始化顺序、会话不存在、并发 prompt、模型错误、CLI 退出或超时等业务错误 `-32000`。响应只包含固定错误摘要。相同连接重复使用在途 ID 会断开连接，已有执行继续运行。

## 会话与进程生命周期

每会话允许一个在途 prompt，忙时立即报错。成功后保留 Pi 内存上下文，后续 prompt 使用同一进程。`prompt success:true` 仅确认提交，最终结果同时要求匹配的接受响应、成功的 assistant stopReason 与 `agent_settled`。模型 error、aborted、length、协议异常和提前退出均返回错误。

状态包括 `idle`、`running`、`cancelled`、`interrupted`、`closed`。执行失败进入 interrupted。取消、中断和关闭后创建新会话继续任务。`pid` 仅表示该会话的监督进程 PID，尚未启动或已经确认退出时为 null。监督器异常死亡后即使仍有工具存活，`pid` 也为 null，因此不能单凭该字段判断后代回收完成。

每会话通过同一二进制的内部监督模式启动独立 Linux subreaper。取消先限时发送 `clear_queue`、`abort`，再通知监督进程回收。监督进程按 `/proc` 追踪后代，使用 PID 与启动时间核对身份，经 pidfd 冻结、终止并收养回收独立进程组的工具，直到 `waitpid` 确认 ECHILD，随后通过 Pi 不继承的专用通道发送清理完成回执。服务同时确认监督器退出码为零和回执有效，才返回 cancelled 或 close 成功。内核不可中断 I/O 导致回收尚未结束时，在途会话维持清理中的 running 状态。

监督器被外部 SIGKILL、OOM 终止或缺少回执时，会话进入 interrupted，prompt/close 返回 `process cleanup failed`，重复 close 和重启后仍保留失败结果。运行中独立等待监督器退出，即使 detached 工具保持 stdout 打开也能及时报告错误。Pi 的父死亡信号尽力终止 Pi 本身，但监督器异常死亡后可能遗留已脱离其管控的工具，服务不会声称全部后代已回收，也不会通过扫描其他会话兜底。此时确认清除遗留进程需要外层沙箱停止或删除。

连接断开只停止该连接的事件投递。任务继续运行，重连初始化后可查询状态或取消。已产生的通知与 prompt 响应仅投递到提交连接，重连通过 status 观测，执行不会重放。

状态记录含会话 ID、cwd、状态和清理失败标记，经临时文件、fsync 和 rename 原子提交。服务锁由 root 服务与各监督进程共享，Pi 不继承锁。服务意外退出后，仍存活的监督进程收到父死亡信号并清理后代。旧监督进程退出前，新服务拒绝启动。锁释放仅证明监督器已退出，异常退出可能先于后代清理。恢复将旧 idle/running 状态转换为 interrupted，并将缺少回执的清理结果标为失败，保留 closed/cancelled 终态及已记录的清理失败。SIGTERM 正常停机同样将尚存会话标记 interrupted。

## 资源限额与日志

| 资源 | 默认限额 |
| --- | --- |
| 可执行会话 | 64 个 idle/running 会话 |
| 状态历史 | 256 个，满后新建会话淘汰一个终态记录 |
| WebSocket 连接 | 16 个 |
| 每连接在途请求 | 128 个 |
| WebSocket 消息及帧 | 1 MiB |
| Pi JSONL 单记录 | 1 MiB，严格按 LF 拆帧 |
| 每连接输出队列 | 32 条 |
| 每 Pi 输入事件队列 | 32 条 |
| WebSocket 单次写入 | 5 秒 |
| Pi 命令写入 | 2 秒 |
| Pi 配置响应 | 每条命令 10 秒 |
| 协作取消阶段 | 最多 250 毫秒 |

输出队列满或客户端写入超时会断开慢连接，后台继续消费 Pi 事件。取消控制独立于输出队列。日志仅记录固定启动与错误摘要，Pi stderr 丢弃，提供方原始错误、完整命令和凭据均不写日志。

## 验证

```sh
cargo test -p ursi-agent-cli-adapter -p ursi-session-service
cargo clippy -p ursi-agent-cli-adapter -p ursi-session-service --all-targets -- -D warnings
```

集成用例通过真实 HTTP/WebSocket 连接运行 Python fake RPC 子进程，覆盖鉴权、路径越界、请求关联、严格 LF、事件顺序、模型错误、并发拒绝、取消后代、断线重连、进程异常、消息超限、执行期限与服务重启。cwd 回归覆盖首次与复用轮次的 symlink/目录替换，以及固定句柄启动。外部 SIGKILL 回归覆盖取消中、运行中和 idle 监督器死亡，验证清理失败持久化与其他会话继续可用。该回归在独立测试 subreaper 中执行，由测试通过登记的 pidfd 终止并收割故意保留的 detached 证据进程。相同测试二进制可用 root 运行，覆盖 UID/GID 1000 降权、补充组清空及配置权限。

真实模型验收通过正式 Runtime 镜像与管理员提供的 Pi 配置执行，需同时验证 SSH/SFTP 输入、模型修改产物与仓库测试结果。
