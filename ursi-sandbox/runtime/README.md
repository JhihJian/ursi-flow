# 独立沙箱 Agent 执行

`pi-execution` 环境可独立启动沙箱、准备 Git 仓库并执行真实 Pi 任务。运行链路由 Gateway、Runtime 镜像、bundle 和独立客户端组成，无需启动 server、FSM 或 Web。Pi 完成任务后，客户端通过 SSH/SFTP 独立检查文件差异和测试结果。

## 交付组成

| 组件 | 职责 | 使用说明 |
| --- | --- | --- |
| `ursi-gateway` | 容器、数据卷、生命周期、端点与配置白名单 | [Gateway](../gateway/README.md) |
| `ursi-runtime-pi` 镜像 | Pi 1.5.0、Git、SSH/SFTP、系统环境与 supervisord | [镜像与 bundle](IMAGE-README.md) |
| Runtime bundle | 会话服务、Pi Adapter、启动与监督配置 | [会话服务](bundle/session-service/README.md) |
| `ursi-sandbox-client` | Gateway HTTP、SSH/SFTP、ACP 调用与独立验收 | [客户端](../client/README.md) |

Gateway 只管理资源。session-service 管理会话和 CLI 进程，监督器管理常驻服务。IDE、CDP、noVNC 属于后续独立环境能力，现有原生服务边界见 [Runtime 契约](CONTRACT.md)。

## 构建与验收

使用 Linux、本机 Docker daemon、Rust 工具链及 OpenSSH 客户端。session-service 需要支持 pidfd 的内核和相应 Docker seccomp 策略。二进制架构与 glibc 要求见镜像说明。

从独立产品根 `ursi-sandbox/` 执行：

```bash
cargo build -p ursi-gateway -p ursi-session-service -p ursi-sandbox-client
docker build -t ursi-runtime-pi:local runtime/image
runtime/scripts/build-bundle.sh \
  "$PWD/target/debug/ursi-session-service" /tmp/ursi-bundle
```

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

管理员准备 root 私有配置目录，通过 `URSI_GATEWAY_RUNTIME_PROFILES` 配置白名单。客户端创建时引用 `runtime_profile: "pi"` 与 bundle URL/SHA256，等待就绪，再通过 SSH/SFTP 准备项目、ACP 创建会话和提交任务。完整命令与端点配置见客户端说明。

同一会话成功完成后保留 Pi 内存上下文。断线后可查询状态或取消，任务不会重放。服务重启后未完成任务转为 interrupted。取消、关闭成功表示已确认进程回收，监督器异常退出则明确报告清理失败，需停止或删除外层沙箱收敛。

凭据分别供应给服务和 CLI。Agent 以 UID/GID 1000 运行，session token 和服务状态由 root 私有目录保护。单个沙箱内的会话共享 agent 用户与工作区，隔离不同信任主体应使用不同沙箱。
