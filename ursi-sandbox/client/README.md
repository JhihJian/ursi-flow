# 独立沙箱客户端与真实 Agent 验收

`ursi-sandbox-client` 通过 Gateway HTTP 管理沙箱，通过 SSH/SFTP 操作仓库，通过 ACP WebSocket 驱动 Agent。它与 server、FSM、Web 和 session-service crate 独立，仅使用 [Gateway 契约](../gateway/CONTRACT.md) 与 [Agent 契约](../runtime/AGENT-CONTRACT.md)。

## 构建与定向验证

以下命令从独立产品根 `ursi-sandbox/` 执行，产物位于该根目录的 `target/`。

```bash
cargo build -p ursi-sandbox-client
cargo test -p ursi-sandbox-client
cargo clippy -p ursi-sandbox-client --all-targets -- -D warnings
python3 -B -m unittest discover -s client/scripts -p 'test_*.py' -v
./target/debug/ursi-sandbox-client --help
```

常规测试使用 fake HTTP/ACP 对端检查协议和 CLI 退出码，Python 策略测试检查 opt-in、root 入口、scope 清理边界、跨 UID 进程身份与取消回收判据，以及失败诊断脱敏。`real_pi_agent_acceptance` 默认 ignored。真实执行需要集成后的 Gateway、正式 Runtime 镜像、bundle 和真实模型配置，并显式启用 `URSI_AGENT_ACCEPTANCE=1`。

依赖工具：构建需要 Rust 工具链，SSH/SFTP 子命令需要 OpenSSH 客户端。真实验收需要以 root 身份运行，具备 Linux、本机 Docker daemon、Python 3.10+、`docker`、`ssh`、`sftp`、`ssh-keygen`。容器内的 Python3、Git、Pi 及 SSH 服务由正式 Runtime 镜像提供。

## CLI 配置与调用

身份通过环境变量或文件读取，同一种身份设置一种来源。凭据内容不放入命令参数。

| 配置 | 用途 |
| --- | --- |
| `URSI_GATEWAY_URL` | Gateway HTTP(S) 根地址 |
| `URSI_GATEWAY_KEY` 或 `URSI_GATEWAY_KEY_FILE` | Gateway Bearer 身份 |
| `URSI_ACP_URL` | 完整 ACP WS(S) 地址，例如 `ws://172.17.0.2:8765/acp` |
| `URSI_SESSION_TOKEN` 或 `URSI_SESSION_TOKEN_FILE` | session-service Bearer 身份 |
| `URSI_CLIENT_TIMEOUT_SECS` | 每次操作总期限，默认 120 秒，范围 1..86400 |

Gateway 和 ACP 支持 TLS。明文 HTTP/WS 适用于受控本机容器网络。URL 拒绝用户信息、query 和 fragment，HTTP 请求关闭重定向。客户端对配置的 Bearer 身份做输出脱敏。

```bash
export URSI_GATEWAY_URL=http://127.0.0.1:8899
export URSI_GATEWAY_KEY_FILE=/private/gateway-key
CLIENT=./target/debug/ursi-sandbox-client

$CLIENT gateway capabilities
$CLIENT gateway create /private/sandbox-spec.json
$CLIENT gateway list
$CLIENT gateway status SANDBOX_ID
$CLIENT gateway endpoints SANDBOX_ID
$CLIENT gateway stop SANDBOX_ID
$CLIENT gateway start SANDBOX_ID
$CLIENT gateway delete SANDBOX_ID
```

创建规格直接使用契约 JSON。正式 Agent 沙箱的关键字段为：

```json
{
  "image": "ursi-runtime-pi:local",
  "runtime_profile": "pi",
  "ports": [
    {"name":"ssh","port":2222,"visibility":"public","ready":true},
    {"name":"session","port":8765,"visibility":"internal","ready":true}
  ],
  "memory_mb": 2048,
  "cpus": 2.0,
  "bundle": {
    "url": "http://CONTAINER_REACHABLE_HOST:PORT/bundle.tar.gz",
    "sha256": "REPLACE_WITH_64_HEX_DIGITS",
    "min_image_level": 1
  }
}
```

Gateway 的创建、启停、删除返回受理结果。调用方继续查询，直到目标 `status` 且 `operation:null`。删除完成后查询为 404。

### SSH 与 SFTP

```bash
$CLIENT ssh HOST PORT /private/id_ed25519 /private/known_hosts /private/prepare.sh
$CLIENT sftp-put HOST PORT /private/id_ed25519 /private/known_hosts ./calculator.py /ursi/workspace/repo/calculator.py
$CLIENT sftp-get HOST PORT /private/id_ed25519 /private/known_hosts ./calculator.py /ursi/workspace/repo/calculator.py
```

SSH 固定使用 `agent` 用户、公钥和指定私钥，禁用密码及交互认证。命令文件经 stdin 交给远端 `sh -se`。专用 known_hosts 使用首次连接信任（TOFU），后续密钥变化拒绝连接。需要预先校验主机身份时，可先向该文件写入受信任的主机公钥。每个沙箱使用独立 known_hosts，stop/start 复用同一文件。

### ACP 会话

```bash
export URSI_ACP_URL=ws://CONTAINER_IP:8765/acp
export URSI_SESSION_TOKEN_FILE=/private/session-token

$CLIENT acp initialize
$CLIENT acp new /ursi/workspace/repo
$CLIENT acp prompt SESSION_ID /private/prompt.txt
$CLIENT acp status SESSION_ID
$CLIENT acp cancel SESSION_ID
$CLIENT acp close SESSION_ID
```

每个 CLI 进程先初始化一条 ACP 连接。`new` 返回 `sessionId`，后续操作使用同一服务身份和会话 ID。prompt 在执行期间输出 JSONL `update`，最终输出 `result`。CLI 退出码为：

| 退出码 | 含义 |
| --- | --- |
| 0 | 操作完成，prompt 收到 `stopReason:end_turn` |
| 2 | prompt 收到 `stopReason:cancelled` |
| 1 | 远端错误、协议错误、传输错误、超时或本地操作失败 |

`cancel` 是通知。它返回 0 仅表示已发送，完成取消需要原 prompt 返回 `cancelled`，随后查询 `status`。取消可从另一终端运行。断线和超时保留远端会话，调用方应重新连接查询状态并按需取消。客户端不重放请求。

Rust 库暴露 `Gateway`、`Acp`、`Ssh`、`Secret` 和 `PromptOutcome`。每条 `Acp` 连接串行执行请求，通知由回调接收，按请求 ID 和 JSON 类型严格关联响应。并发控制使用另一个连接，适合执行中查询、取消和关闭会话。ACP 单帧与消息上限均为 1 MiB。

## 真实验收输入

验收脚本启动独立 Gateway，并将正式 bundle 发布到监听 `0.0.0.0` 的临时 HTTP 端口。Gateway 同样监听 `0.0.0.0` 临时端口，命名空间为随机 scope。会话端点通过 Gateway 返回的 internal 地址直连，需要宿主能访问本地容器 IP。本验收覆盖直连 ACP 路径。

操作方准备一个最小配置目录，包含：

- `pi/models.json`：验收专用模型和凭据配置。
- `session.json`：`{"provider":"供应商标识","model":"模型标识"}`。
- 可选 `pi/auth.json`：模型所需的最小认证内容。
- 可选 `session-token`：至少 32 字符。缺省时自动生成。
- 使用 `--ssh-key` 时提供 `authorized_keys`，与无口令私钥匹配。省略 `--ssh-key` 时自动生成临时 Ed25519 密钥。

脚本只复制操作方 `--config-dir` 中上述明确列出的 Pi 配置文件，不会读取或复制宿主用户的全量 Pi auth。真实验收入口先检查 root 身份，再接触配置与创建资源。Gateway profile 和 Runtime 要求配置目录归 root 所有且权限为 0700，因此应使用下方 `sudo` 入口。凭据文件复制到 `/tmp` 下 root 所有的 0700 临时目录，文件权限为 0600，任务结束后删除。脚本生成 `URSI_GATEWAY_RUNTIME_PROFILES` 指向的 JSON 文件：`{"pi":{"config_dir":"/abs/private/config"}}`。集成 Gateway 必须支持此 profile，并按契约设置 SSH capabilities 和 `/run/ursi/config` 只读挂载。

bundle 的默认发布地址来自 `docker network inspect bridge` 的网关配置。该地址是否能下载由正式 Runtime 启动验证。自定义 Docker 网络、防火墙等环境可使用 `--bundle-host` 指定容器可达的宿主地址。

```bash
sudo env URSI_AGENT_ACCEPTANCE=1 python3 client/scripts/agent_acceptance.py \
  --gateway /absolute/path/ursi-gateway \
  --client "$PWD/target/debug/ursi-sandbox-client" \
  --image ursi-runtime-pi:local \
  --bundle /private/runtime-bundle.tar.gz \
  --config-dir /private/minimal-pi \
  --evidence /tmp/ursi-agent-evidence.json
```

复用操作方 SSH 身份时增加 `--ssh-key /private/id_ed25519`。可调期限为 `--operation-timeout 60`、`--lifecycle-timeout 240`、`--prompt-timeout 300`，单位为秒，每项范围 1..3600。每个命令、轮询和进程回收都有期限。

Cargo ignored 测试使用同一个脚本，也要求 root。以下命令从独立产品根 `ursi-sandbox/` 执行。先在已配置 Rust 工具链的 root shell（`sudo -i`）中进入该目录。日常验证使用前面的非 ignored 定向测试，无需 root：

```bash
export URSI_AGENT_ACCEPTANCE=1
export URSI_ACCEPTANCE_GATEWAY=/absolute/path/ursi-gateway
export URSI_ACCEPTANCE_BUNDLE=/private/runtime-bundle.tar.gz
export URSI_ACCEPTANCE_CONFIG_DIR=/private/minimal-pi
cargo test -p ursi-sandbox-client --test real_agent -- --ignored --nocapture
```

可选环境变量为 `URSI_ACCEPTANCE_IMAGE`、`URSI_ACCEPTANCE_SSH_KEY`、`URSI_ACCEPTANCE_BUNDLE_HOST` 和 `URSI_ACCEPTANCE_EVIDENCE`。

## 真实验收判据与证据

1. 正式 Runtime 就绪后，以 agent 公钥登录，经 SFTP 上传有函数 bug 和基线测试的小型 Git 仓库。
2. 真实 Pi 修改函数并补测试，收到 `end_turn` 后，通过独立 SSH 检查 Git 差异、运行 unittest 和固定断言。再注入原 bug，确认新增测试能识别回归。
3. 经 SFTP 拉回函数和测试文件，记录内容摘要。
4. 创建另一会话。在原会话提交唯一标识的前台长任务，观察 ACP 工具执行事件，通过 `/proc/<pid>/stat` 与 `cmdline` 确认监督器和工具父子进程身份且仍存活后取消。status.pid 指向 root 监督器，SSH 使用 agent 身份读取 `/proc`，不依赖跨 UID 的信号权限。原 prompt 必须返回 `cancelled`，status 为 cancelled 且 pid 为空，`/proc` 中事先记录的监督器、工具父子 PID 与唯一标识进程立即消失。进程扫描权限不足也视为验收失败。
5. 另一会话继续完成真实 prompt，关闭两个会话。停止再启动沙箱，文件摘要保持一致，测试继续通过。
6. Gateway 删除后查询为 404，随机 scope 下无所属容器和卷。

原始模型事件、Gateway 输出和 SSH 输出仅留在临时目录。仓库外的 JSON 证据保留阶段结果、文件与差异摘要、工具事件计数、取消进程证据及清理结果。失败证据记录阶段、取消子阶段和错误类别。客户端失败另记固定命令类别（如 `ssh`、`acp cancel`、`acp prompt`）及退出码，启动失败或超时的退出码为 null。取消子阶段覆盖工具上传、启动等待、取消前身份核验、发送取消、等待原 prompt、取消状态查询、回收核验和另一会话验证。证据不保存命令参数、keys、模型配置、prompt 原文或原始 stdout/stderr。模型错误、缺少 profile 支持、镜像/bundle 不匹配都使真实验收失败。

失败时先请求 Gateway 删除，然后停止 Gateway，再核对 Docker ownership 标签并清理本次随机 scope。脚本处理 SIGINT/SIGTERM。SIGKILL 或宿主掉电后，可根据证据中的 `scope` 人工核对残留资源。清理始终使用精确 scope 标签，禁止全局 prune。
