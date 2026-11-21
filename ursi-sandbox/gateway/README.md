# Sandbox Gateway

独立的 Rust 沙箱资源管理服务，包含 HTTP 控制面、SQLite 元数据与恢复对账、Docker 驱动和可选的 WebSocket 字节隧道。运行与验收均不依赖 server、Agent CLI 或 ACP 服务。

## 构建与启动

从独立产品根 `ursi-sandbox/` 执行：

```bash
cargo build -p ursi-gateway --release
export URSI_GATEWAY_KEY="$(openssl rand -hex 32)"
export URSI_GATEWAY_DB="$PWD/.localdata/gateway.sqlite"
export URSI_GATEWAY_NAMESPACE=ursi-local
export URSI_GATEWAY_TUNNEL=true
./target/release/ursi-gateway
```

默认监听 `0.0.0.0:8899`。Docker CLI 和本机 Unix socket daemon 必须可用。Gateway 固定启动时解析出的 Docker 端点，并将 daemon ID、namespace 与数据库绑定。更换 Docker 目标或 namespace 必须使用独立数据库。一个资源 namespace 只由一份数据库管理，不可让多份数据库共享同一 namespace。

数据库通过进程文件锁独占，使用 SQLite WAL 与 FULL 同步提交。进程停止不会删除沙箱，重启后继续处理持久化意图。后台调度异常或元数据无法读取时停止受理并非零退出，由运行环境重启或管理员排查。SIGTERM/SIGINT 触发最多 3 秒的请求退出宽限，防止慢连接无限占用数据库锁。不要只备份主 SQLite 文件而遗漏未检查点的 WAL，备份时停止 Gateway 或使用 SQLite 一致性备份。

| 环境变量 | 默认值 | 用途 |
|---|---|---|
| `URSI_GATEWAY_KEY` | 必填 | 至少 16 字节、无空白的服务间 Bearer key |
| `URSI_GATEWAY_BIND` | `0.0.0.0:8899` | HTTP 监听地址 |
| `URSI_GATEWAY_DB` | `./gateway.sqlite` | SQLite 路径 |
| `URSI_GATEWAY_NAMESPACE` | `ursi` | 容器和数据卷归属范围 |
| `URSI_GATEWAY_DRIVER` | `docker` | `docker` 或仅用于测试的 `fake` |
| `URSI_GATEWAY_TUNNEL` | `false` | 是否启用隧道 |
| `URSI_GATEWAY_OBSERVER_SOCKET` | 未配置 | 配对的宿主 Observer 的 Unix socket 路径，仅 Docker 驱动支持 |
| `URSI_GATEWAY_RUNTIME_PROFILES` | 未配置 | 管理员白名单 JSON 路径，允许受控的只读 Runtime 配置挂载 |
| `URSI_GATEWAY_REGISTRY` | `./gateway-registry.json` | 管理员维护的 bundle 定义与 `image -> bundles` 注册表 |

Docker 首版支持本机绝对路径 Unix socket，TCP/TLS/SSH daemon 和 Kubernetes/E2B 驱动尚未支持。默认编译 Docker 与 fake，生产可使用 `--no-default-features --features driver-docker`。fake 的实际资源保存在内存，仅供测试。

启用网络观测时，每个 Gateway 实例单独配对一个 Observer，使用专用目录和访问组。Gateway 重启后读取 socket 配置；`observer_enabled` 表示已配置，不反映服务在线状态。权限准备、启停和下载示例见 [Observer 使用说明](../observer/README.md)。

## HTTP 使用

创建请求直接使用 SandboxSpec，`Idempotency-Key` 可选。同一 key 与相同规格返回原沙箱，不同规格返回冲突。删除后的 key 保留为墓碑，不能被用于重新创建。

```bash
curl -sS http://127.0.0.1:8899/api/v1/sandboxes \
  -H "Authorization: Bearer $URSI_GATEWAY_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: example-001' \
  -d '{"image":"alpine:3.22","command":["sleep","3600"]}'
```

创建和操作受理返回 202，需查询响应中的 `id`，等待 `operation` 为 null 且 `status` 达到目标状态。正在执行对账的短时间内操作可能返回 409，客户端可稍后重试。具体路径、状态和请求体见 [CONTRACT.md](CONTRACT.md)。

`/ursi/workspace` 挂载本沙箱命名卷。停止保留容器与数据；重建显式选择 `preserve_data`；删除移除本沙箱全部已知代际的容器和卷。若卷被外部占用，删除保持 pending 并持续重试，不会把清理失败报告为完成。

## 镜像与安全边界

容器默认使用内存/CPU/pids 限制、`cap-drop ALL` 和 `no-new-privileges`，不提供特权容器、任意宿主目录或 Docker socket 挂载接口。`runtime_profile` 可引用管理员白名单中的 root 所有、0700 配置目录，只读挂载到 `/run/ursi/config`。Runtime profile 使用固定七项 SSH/降权/回收能力，Agent 仍以 UID 1000 零 capabilities 运行。配置格式和凭据目录布局见 [Agent 执行契约](../bundles/pi-agent/AGENT-CONTRACT.md)。镜像只能声明 `/ursi/workspace` 数据卷，额外匿名卷被拒绝，防止重建泄漏数据资源。

容器端口不发布到宿主机，受管端点只通过 Gateway bridge 访问。端点能力来自管理员 `image -> bundles` 注册表，未注册镜像没有受管端点。CDP/noVNC 只能走可信 Gateway 路径。受控网络隔离取决于部署网络配置，Docker 默认 bridge 不是沙箱间防火墙，也不是恶意代码的强安全边界。

Gateway key 是管理权限凭据，持有者能管理该 Gateway 的全部沙箱。它不替代 SSH/ACP 等上层服务鉴权。服务当前为 HTTP，跨非可信网络部署需在前面终止 TLS 并限制访问来源。Runtime URL 和摘要只来自管理员注册表，公共 Sandbox DTO 不回显；不要将凭据放进运行规格或标签。本版通过管理员配置目录注入 Runtime 所需凭据，不提供持久化密钥管理或通用秘密注入 API。

镜像可使用 Docker HEALTHCHECK 验证实际服务，声明的每个端点还需 TCP readiness。只声明进程而没有健康检查的镜像，只能证明进程在运行。Runtime 包来源由管理员注册表绑定，Gateway 校验镜像级别，包完整性和服务装配由 Runtime 负责。bundle 能力必须同时出现在管理员注册表中，镜像或用户提交的 manifest 不会自动获得 Gateway 信任。注册表可通过 `GET/PUT /api/v1/registry` 管理，格式示例见 `gateway-registry.example.json`。

## 测试与独立验收

```bash
# 按改动的工作包选择筛选器：driver:: / lifecycle:: / gateway_api:: / tunnel::
cargo test -p ursi-gateway --lib lifecycle::
cargo test -p ursi-gateway --test process_shutdown
# 阶段性交付时单独跑真实 Docker 验收
cargo test -p ursi-gateway --test docker_acceptance -- --ignored --nocapture
```

真实 Docker 验收命令使用已缓存或可拉取的 `alpine:3.22` 构建专用镜像。测试启动独立 Gateway 进程，验证生命周期、两种重建、数据保留、鉴权、端口隔离、100 KB 隧道半关闭、强杀恢复与删除重试。每轮使用随机 namespace，退出时清理该 namespace 的容器与卷，日志和数据库保留在测试输出的临时目录。

验收镜像只验证网关，不能代替正式 Runtime、Agent CLI 或工作流验收。详细结果及 Grasp 行为对照见 [ACCEPTANCE.md](ACCEPTANCE.md)。
