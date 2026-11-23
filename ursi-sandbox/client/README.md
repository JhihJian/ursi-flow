# 独立沙箱客户端与真实 Agent 验收

`ursi-sandbox-client` 按 [Gateway 契约](../gateway/CONTRACT.md) 管理沙箱，通过逻辑端点转发 TCP，并提供 SSH/SFTP 工作区访问。只需这些能力时，使用 `cargo build -p ursi-sandbox-client --no-default-features` 构建。默认构建另含 [ACP 消费方](consumers/acp/SPEC.md)，按 [Agent 契约](../bundles/pi-agent/AGENT-CONTRACT.md) 驱动会话；两种构建均独立于 Gateway 和 session-service crate。

## 构建与定向验证

以下命令从独立产品根 `ursi-sandbox/` 执行，产物位于该根目录的 `target/`。

```bash
cargo build -p ursi-sandbox-client
cargo test -p ursi-sandbox-client
cargo test -p ursi-sandbox-client --no-default-features
cargo clippy -p ursi-sandbox-client --all-targets -- -D warnings
python3 -B -m unittest discover -s client/scripts -p 'test_*.py' -v
./target/debug/ursi-sandbox-client --help
```

常规测试使用 fake HTTP/ACP/ursi-tcp-v1 对端检查协议、bridge 字节转发和 CLI 退出码，Python 策略测试检查 opt-in、root 入口、scope 清理边界、跨 UID 进程身份与取消回收判据，以及失败诊断脱敏。`real_pi_agent_acceptance` 默认 ignored。真实执行需要集成后的 Gateway、正式 Runtime 镜像、bundle 和真实模型配置，并显式启用 `URSI_AGENT_ACCEPTANCE=1`。

依赖工具：构建需要 Rust 工具链，SSH/SFTP 子命令需要 OpenSSH 客户端。真实验收需要以 root 身份运行，具备 Linux、本机 Docker daemon、Python 3.10+、`docker`、`ssh`、`sftp`、`ssh-keygen`。容器内的 Python3、Git、Pi 及 SSH 服务由正式 Runtime 镜像提供。

## CLI 配置与调用

身份通过环境变量或文件读取，同一种身份设置一种来源。凭据内容不放入命令参数。

| 配置 | 用途 |
| --- | --- |
| `URSI_GATEWAY_URL` | Gateway HTTP(S) 根地址 |
| `URSI_GATEWAY_KEY` 或 `URSI_GATEWAY_KEY_FILE` | Gateway Bearer 身份 |
| `URSI_SANDBOX_ID` | ACP 通过 Gateway bridge 时的沙箱 ID |
| `URSI_ACP_ENDPOINT` | ACP endpoint 名，默认 `agent_session` |
| `URSI_SESSION_TOKEN` 或 `URSI_SESSION_TOKEN_FILE` | Pi 会话服务的 Bearer 身份，仅 ACP 消费方读取 |
| `URSI_CLIENT_TIMEOUT_SECS` | 每次操作总期限，默认 120 秒，范围 1..86400 |

Gateway HTTP 和 bridge WebSocket 支持 TLS。明文 HTTP/WS 适用于受控网络。URL 拒绝用户信息、query 和 fragment，HTTP 请求关闭重定向。客户端对配置的 Gateway Bearer 做输出脱敏。CLI 的 ACP、SSH 和 SFTP 都通过逻辑端点。bridge 握手使用 Gateway Bearer；转发后的 SSH 公钥和 ACP 会话认证由各自协议处理。

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
  "memory_mb": 2048,
  "cpus": 2.0
}
```

镜像、逻辑端点和 Runtime 包来源由管理员预先绑定到 Gateway 注册表。Gateway 的创建、启停、删除返回受理结果。调用方继续查询，直到目标 `status` 且 `operation:null`。删除完成后查询为 404。

### 逻辑 endpoint bridge

```bash
$CLIENT gateway endpoints SANDBOX_ID
$CLIENT forward SANDBOX_ID ssh
# 默认监听 127.0.0.1:0，JSONL result 返回实际 listen 地址。
$CLIENT forward SANDBOX_ID ssh 127.0.0.1:22022
```

endpoint 查询只返回 `name`、`bundle`、`protocol`、`port`、`state`、`ready`。`address` 和 `visibility` 不属于客户端结构。forward 只接受沙箱 ID 与 endpoint 名称，每个本地 TCP 连接都通过 `GET /api/v1/sandboxes/{id}/connect/{endpoint_name}` 建立 `ursi-tcp-v1` WebSocket，并携带 Gateway Bearer。客户端不接受任意远端 host/port，也不解析 WebSocket 上承载的 SSH、ACP 或 HTTP。

WebSocket 二进制帧承载 TCP 字节，文本 `eof` 进行半关闭，Ping/Pong 保活，连接生命周期随本地连接和 Ctrl-C 取消。客户端消息不超过 64 KiB。Gateway key 只从 `URSI_GATEWAY_KEY` 或 `URSI_GATEWAY_KEY_FILE` 读取，绝不放入 argv 或日志。

### SSH 与 SFTP

```bash
$CLIENT ssh SANDBOX_ID ssh /private/id_ed25519 /private/known_hosts /private/prepare.sh
$CLIENT sftp-put SANDBOX_ID ssh /private/id_ed25519 /private/known_hosts ./calculator.py /ursi/workspace/repo/calculator.py
$CLIENT sftp-get SANDBOX_ID ssh /private/id_ed25519 /private/known_hosts ./calculator.py /ursi/workspace/repo/calculator.py
```

SSH 固定使用 `agent` 用户、公钥和指定私钥，禁用密码及交互认证。客户端会为 SSH/SFTP 自动创建本地临时 bridge；命令本身不解析 bridge 内的 SSH 协议。命令文件经 stdin 交给远端 `sh -se`。专用 known_hosts 使用首次连接信任（TOFU），后续主机密钥变化拒绝连接。每个沙箱使用独立 known_hosts，stop/start 复用同一文件。

### 供标准 SSH 工具接入的 `proxy` 与 `ssh-config`

只支持 `ssh user@host` 的第三方工具（例如 pi coding-agent 的 ssh extension）不需要改造。`proxy` 把本地 stdin/stdout 直通到逻辑端点，用作 `ProxyCommand`；`ssh-config` 打印一次性静态配置块。

```bash
# 打印配置块，追加到 ~/.ssh/config。不写文件、不访问 Gateway。
$CLIENT ssh-config >> ~/.ssh/config

# 之后任意支持 ssh_config 的工具都可以直接使用。
ssh ursi-abc123 'pwd'
# 以 pi 的 ssh extension 为例，沙箱 ID 作为主机名，工作目录跟在冒号后。
pi -e ./ssh.ts --ssh ursi-abc123:/ursi/workspace/repo
```

`ssh-config` 输出的主体是固定匹配：

```text
Host ursi-*
  User agent
  ProxyCommand /usr/local/bin/ursi-sandbox-client proxy %h ssh
  IdentityFile ~/.ursi/id_ed25519
  UserKnownHostsFile ~/.ursi/known_hosts
  StrictHostKeyChecking accept-new
```

`proxy` 从 `%h` 剥掉 `ursi-` 前缀得到沙箱 ID，因此别名与沙箱一一对应，不依赖端口或 DNS。每个 SSH 连接独立建立一条 `ursi-tcp-v1` WebSocket，路由由 URL 路径显式指定，不靠源端口推断。`proxy` 的 stdout 只承载隧道字节，错误写入 stderr 并返回非零，因此不会污染 SSH 协议流。

选项：`--binary PATH` 指定 `ProxyCommand` 使用的客户端绝对路径，`--identity`、`--known-hosts` 覆盖默认路径，`--endpoint` 改端点名（默认 `ssh`），`--host-key-policy pin|ignore` 选择主机密钥策略。

必须知道的边界：

- `URSI_GATEWAY_URL` 与 `URSI_GATEWAY_KEY[_FILE]` 必须存在于调用 `ssh` 的进程环境中，因为 `ProxyCommand` 继承调用方环境。推荐 `URSI_GATEWAY_KEY_FILE` 加 0600 文件，避免凭据进入 `/proc/<pid>/environ`。
- `User` 必须是 `agent`。工具若硬编码 `root@host` 会覆盖配置块并认证失败。
- 沙箱 sshd 禁止 TCP 转发（`AllowTcpForwarding no`），不要使用 `ssh -L`/`-R`，需要端口转发时用 `forward`。
- 主机密钥在容器内生成，保数据重建或销毁重建后会变化，但 stop/start 不变。默认 `pin` 策略下重建后需 `ssh-keygen -R ursi-<id> -f ~/.ursi/known_hosts` 再连接；`ignore` 策略不记录主机密钥，信任锚退到 Gateway Bearer 通道。

### ACP 会话

```bash
# Gateway bridge 模式：不需要 endpoint address
export URSI_SANDBOX_ID=SANDBOX_ID
export URSI_ACP_ENDPOINT=agent_session
export URSI_SESSION_TOKEN_FILE=/private/session-token
export URSI_GATEWAY_URL=http://127.0.0.1:8899
export URSI_GATEWAY_KEY_FILE=/private/gateway-key
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

通用库暴露 `Gateway`、`Bridge`、`Endpoint`、`Ssh` 和 `Secret`。启用 `acp` 后可使用 `acp::{Acp, PromptOutcome}`，原有的 crate 根导入路径也可用。每条 `Acp` 连接串行执行请求，通知由回调接收，按请求 ID 和 JSON 类型严格关联响应。并发控制使用另一个连接，适合执行中查询、取消和关闭会话。ACP 单帧与消息上限均为 1 MiB。

## 真实验收输入

从 `ursi-sandbox/` 运行 `builder/build-image.sh pi` 构建镜像。用 `cargo build -p ursi-session-service` 编译 Pi 会话服务，再运行 `builder/scripts/build-bundle.sh target/debug/ursi-session-service dist` 生成 `dist/runtime-bundle.tar.gz`，作为下文 `--bundle` 的输入。

验收脚本启动独立 Gateway，并将正式 bundle 发布到监听 `0.0.0.0` 的临时 HTTP 端口。Gateway 同样监听 `0.0.0.0` 临时端口，命名空间为随机 scope。SSH 和 ACP 通过逻辑 endpoint bridge 连接，不读取 endpoint address。本验收覆盖 Gateway tunnel 路径。

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
