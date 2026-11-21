# 独立沙箱 Agent 执行

`pi-execution` 环境可独立启动沙箱、准备 Git 仓库并执行真实 Pi 任务。运行链路由 Gateway、Runtime 镜像、bundle 和独立客户端组成，无需启动 server、FSM 或 Web。当前 bundle 只提供 `ssh` 和 `agent_session` 两个端点能力，Pi 完成任务后，客户端通过 SSH/SFTP 独立检查文件差异和测试结果。IDE、CDP、noVNC 是未来 bundle，不是当前实现。

## 交付组成

| 组件 | 职责 | 使用说明 |
| --- | --- | --- |
| `ursi-gateway` | 容器、数据卷、生命周期、端点与配置白名单 | [Gateway](../../gateway/README.md) |
| `ursi-runtime-pi` 镜像 | Pi 1.5.0、Git、SSH/SFTP、系统环境与 supervisord | [镜像与 bundle](../../builder/README.md) |
| Runtime bundle | 会话服务、Pi Adapter、启动与监督配置，以及可组合端点能力清单 | [会话服务](session-service/README.md) |
| `ursi-sandbox-client` | Gateway HTTP、SSH/SFTP、ACP 调用与独立验收 | [客户端](../../client/README.md) |

Gateway 只管理资源。session-service 管理会话和 CLI 进程，监督器管理常驻服务。IDE、CDP、noVNC 属于后续独立环境能力，现有原生服务边界见 [Runtime 契约](../../runtime/CONTRACT.md)。

## 构建与验收

使用 Linux、本机 Docker daemon、Rust 工具链及 OpenSSH 客户端。session-service 需要支持 pidfd 的内核和相应 Docker seccomp 策略。二进制架构与 glibc 要求见镜像说明。

从独立产品根 `ursi-sandbox/` 执行：

```bash
cargo build -p ursi-gateway -p ursi-session-service -p ursi-sandbox-client
builder/build-image.sh pi
builder/scripts/build-bundle.sh \
  "$PWD/target/debug/ursi-session-service" /tmp/ursi-bundle
```

构建器默认生成 `pi-execution` session bundle，并声明 `ssh`/`agent_session`。需要组合能力时，传入一个 manifest 或多个 bundle 定义：

```bash
builder/scripts/build-bundle.sh \
  "$PWD/target/debug/ursi-session-service" /tmp/ursi-bundle \
  --manifest /private/runtime/base.json \
  --bundles /private/runtime/preview.json /private/runtime/metrics.json
```

输入 JSON 只能声明 `bundles`、`required_capabilities`、`services`、`endpoints`、`readiness` 等能力字段。端点必须是 `name`、`protocol`、`port`，不能写 address、visibility 或 Gateway key；组合后的端点名和端口不能重复。构建器保持确定性 tar 与 SHA256，能力定义变化也会改变 manifest version。

准备仓库外的最小模型配置目录，包含 `session.json` 和 `pi/models.json`，按提供方需要增加 `pi/auth.json`。配置内容和权限要求见客户端说明。验收会生成专用 SSH 密钥与服务 token，并临时发布 bundle、启动 Gateway 和沙箱。

```bash
sudo env URSI_AGENT_ACCEPTANCE=1 python3 client/scripts/agent_acceptance.py \
  --gateway "$PWD/target/debug/ursi-gateway" \
  --client "$PWD/target/debug/ursi-sandbox-client" \
  --image ursi-runtime-pi:local \
  --bundle /tmp/ursi-bundle/runtime-bundle.tar.gz \
  --config-dir /private/minimal-pi \
  --evidence /tmp/ursi-agent-evidence.json
```

验收依次检查真实代码修改、回归测试有效性、取消回收、另一会话可用、停止启动后的数据保留，以及删除后的资源清理。证据 JSON 保存判据与摘要，临时凭据随验收清理。已有执行结果见 [独立验收报告](ACCEPTANCE.md)。

## 日常使用

管理员准备 root 私有配置目录，通过 `URSI_GATEWAY_RUNTIME_PROFILES` 配置白名单，并在 Gateway 注册表中明确 `image -> bundles`。Gateway 只为已注册镜像组合并开放 bundle 端点，未注册镜像没有受管端点。客户端创建时只引用镜像、bundle URL/SHA256 和管理员批准的运行 profile，不在 `SandboxSpec` 中配置端点、ports 或 visibility；所有容器端口通过 Gateway bridge 访问。端点能力必须由管理员注册表中的 `image -> bundles` 明确授予。等待就绪后，再通过 `ssh`/SFTP 准备项目、通过 `agent_session` ACP 创建会话和提交任务。

同一会话成功完成后保留 Pi 内存上下文。断线后可查询状态或取消，任务不会重放。服务重启后未完成任务转为 interrupted。取消、关闭成功表示已确认进程回收，监督器异常退出则明确报告清理失败，需停止或删除外层沙箱收敛。

凭据分别供应给服务和 CLI。Runtime 内部 token、SSH key 和 probe key 由服务内部使用，最终用户不需要为每个端点逐一输入。Agent 以 UID/GID 1000 运行，session token 和服务状态由 root 私有目录保护。单个沙箱内的会话共享 agent 用户与工作区，隔离不同信任主体应使用不同沙箱。
