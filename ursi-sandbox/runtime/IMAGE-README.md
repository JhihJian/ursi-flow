# Pi 执行环境镜像与 bundle

`ursi-runtime-pi:local` 提供 `pi-execution` profile：Ubuntu 24.04（glibc 2.39）、Node 24.13.1、Pi 1.5.0、Git、SSH/SFTP、Python3、curl、证书和 supervisord。镜像入口为 `/ursi/bootstrap`，镜像级别为 1。`runtime/image-browser` 在其上提供真实 Chromium、CDP、Xvfb、x11vnc、websockify 和 code-server，镜像级别为 2。browser bundle 组合后才开放 IDE、CDP 和桌面端点。

## 构建

从独立产品根 `ursi-sandbox/` 执行：

```bash
docker build -t ursi-runtime-pi:local runtime/image
runtime/scripts/build-bundle.sh /absolute/path/ursi-session-service /tmp/ursi-bundle
(cd /tmp/ursi-bundle && sha256sum -c runtime-bundle.sha256)

# 组合 browser bundle，端点名称和容器端口必须全局不重复
docker build \
  --build-arg UBUNTU_APT_MIRROR=http://mirrors.aliyun.com/ubuntu \
  --build-arg NPM_REGISTRY=https://registry.npmmirror.com \
  -t ursi-runtime-browser:local runtime/image-browser
runtime/scripts/build-bundle.sh /absolute/path/ursi-session-service /tmp/ursi-bundle \
  --bundles runtime/bundle/browser/definition.json
```

browser 镜像当前已在 Linux amd64 验证，使用 Chrome for Testing 的 `linux64` 包。`UBUNTU_APT_MIRROR` 可覆盖阿里云 Ubuntu 源；`NPM_REGISTRY`、`NODE_MIRROR` 和 `CHROME_FOR_TESTING_MIRROR` 可分别覆盖 npm、Node.js 和浏览器归档的 npmmirror 下载地址。系统默认 Node.js 仍为 24.13.1，code-server 4.96.4 单独使用 `/opt/node20`（`NODE20_VERSION` 默认 20.20.2）。升级浏览器时须同时核对 Playwright 固定版本要求的 revision 和 Chrome 版本。

基础镜像支持 amd64、arm64 的 Node 安装，bundle 中的服务二进制必须匹配镜像架构，glibc 要求不超过 2.39。可用 Docker build args `BASE_IMAGE`、`NODE_VERSION`、`NODE_DOWNLOAD_BASE`、`NPM_REGISTRY` 选择基础镜像和下载源。OpenSSH 源码阶段支持 `UBUNTU_SOURCE_MIRROR`，默认 Ubuntu 官方仓库，例如可指定 `--build-arg UBUNTU_SOURCE_MIRROR=http://mirrors.aliyun.com/ubuntu/`；APT 按 Ubuntu 签名元数据验证源码和软件包。Node 下载校验发行目录中的 SHA256，Pi 固定安装 `@earendil-works/pi-coding-agent@1.5.0`。

Ubuntu 官方 sshd 的 Linux audit 集成会在缺少 `AUDIT_WRITE` 时拒绝 PTY 登录。镜像的独立构建阶段采用 Ubuntu 安全更新源的 OpenSSH 源码，保留发行版补丁，以 `--without-audit --without-pam` 编译 sshd。其余 SSH 工具仍使用发行版软件包，构建工具留在独立阶段。源码补丁版本记录在 `/etc/ursi-sshd-source-version`，SSH 登录 PATH 包含 `/usr/local/bin`，可直接使用 Node 和 Pi。运行所需 capabilities 保持七项。

bundle 构建只要求输入文件可执行，因此镜像测试可传入明确标识的测试程序。真实 Agent 验收必须传入实际 session-service，并通过 ACP 和真实模型执行任务。

## 管理员配置

主机配置目录必须为 root 所有、权限 0700，以只读方式挂载到 `/run/ursi/config`。建议其中所有文件为 root:root、0600，`pi` 子目录为 0700。

| 文件 | 内容 |
| --- | --- |
| `session-token` | 至少 32 字符的独立 Bearer token |
| `authorized_keys` | 允许 agent 登录的 SSH 公钥，每行一条 |
| `session.json` | `{"provider":"提供商","model":"模型"}` |
| `pi/models.json` | Pi 的模型配置 |
| `pi/auth.json` | 可选的 Pi 凭据 |

bootstrap 拒绝缺失配置、可被其他用户访问的配置目录以及可写配置挂载。authorized_keys 会复制到 root 所有的公共公钥文件供 sshd 校验。session-service 以 root 启动，负责将 Pi 配置复制到私有运行目录、以 agent UID/GID 1000 启动 CLI。session token 保留在 root 配置中。

Gateway profile 白名单示例为 `{"pi":{"config_dir":"/absolute/private/config"}}`，通过 `URSI_GATEWAY_RUNTIME_PROFILES` 指定此 JSON 文件。管理员还要在 Gateway 注册表中声明镜像允许组合的 bundle，例如：

```json
{
  "bundles": {
    "pi-execution": {
      "endpoints": [
        {"name": "ssh", "protocol": "ssh", "port": 2222},
        {"name": "agent_session", "protocol": "acp", "port": 8765}
      ],
      "requires": []
    }
  },
  "images": {"ursi-runtime-pi:local": ["pi-execution"]}
}
```

注册表中的依赖必须存在且不能形成循环，组合端点名和端口不能冲突。未注册镜像不开放受管端点。镜像单独运行时使用相同的配置和权限约束：

```bash
docker run --name ursi-runtime-example \
  --cap-drop ALL --security-opt no-new-privileges \
  --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
  --cap-add SETUID --cap-add SETGID --cap-add SYS_CHROOT --cap-add KILL \
  --mount type=bind,src=/absolute/private/config,dst=/run/ursi/config,readonly \
  --mount type=volume,src=ursi-runtime-example-workspace,dst=/ursi/workspace \
  -e URSI_BUNDLE_URL=https://example.invalid/runtime-bundle.tar.gz \
  -e 'URSI_BUNDLE_SHA256=替换为64位小写摘要' \
  -e URSI_BUNDLE_MIN_IMAGE_LEVEL=1 \
  ursi-runtime-pi:local
```

示例 URL 和摘要需替换为已发布 bundle。session-service 默认内部监听 8765，SSH 监听 2222。直接 `docker run` 不发布容器端口；受管访问只能由 Gateway bridge 按管理员注册的 image -> bundles 组合提供。Gateway 管理 address 和 visibility，用户不能在 `SandboxSpec` 中配置 ports 或 visibility。SSH 只接受 agent 公钥，root、密码、代理转发及 TCP 转发均禁用。

## 目录与服务环境

| 路径 | 所有权与用途 |
| --- | --- |
| `/run/ursi/config` | root 私有，只读注入配置 |
| `/run/ursi/agent` | agent:agent 0700，临时运行区域 |
| `/run/ursi/sshd` | root:root 0700，实例 host key 与健康检查私钥 |
| `/run/ursi/supervisor.sock` | root 专用监督器控制 socket |
| `/ursi/workspace` | root:agent 1770，agent 可写，sticky 位保护 root 状态目录项 |
| `/ursi/workspace/.ursi-state` | root:root 0700，持久会话状态 |
| `/opt/ursi/runtime/<sha256>` | root 所有、已校验且按摘要固定的 bundle |

启动只设置这些目录本身的权限，既有仓库文件与状态文件保持所有权和内容。root:agent 的工作区权限让 agent 正常写入，同时禁止其替换 root 的状态目录。挂载卷首次可由 Docker 从镜像初始化目录。

session-service 固定收到：

```text
URSI_SESSION_BIND=0.0.0.0:8765
URSI_SESSION_CONFIG_DIR=/run/ursi/config
URSI_WORKSPACE_ROOT=/ursi/workspace
URSI_SESSION_STATE_DIR=/ursi/workspace/.ursi-state
URSI_PI_BIN=/usr/local/bin/pi
```

bootstrap 向 supervisord 传递最小环境，bundle URL 和额外注入环境不会向常驻服务继承。模型配置使用只读配置文件。

## 校验、就绪与停止

bootstrap 同时检查 Gateway 提供的最低镜像级别与 bundle 清单级别。归档最多 512 MiB、4096 个成员，只接受普通文件与目录，拒绝绝对路径、`..`、重复成员、链接、设备文件以及 PAX/GNU 扩展头。构建器输出 USTAR 格式，bootstrap 在 tarfile 解析前逐块检查头部和总解压量，限制扩展头带来的内存分配。解包后清单逐文件 SHA256 必须匹配，目录与文件权限统一规范化。manifest 的 `bundles`、`required_capabilities`、`services`、`endpoints`、`readiness` 由构建器生成；endpoint 只含 name/protocol/port，不含 address、visibility 或 Gateway key。

缓存保留原始归档。重启先验证归档 SHA256，再重新解包到临时目录，对照已安装内容、权限、类型和路径集合。验证成功后可离线启动，损坏缓存明确失败，保留原目录供排查。缓存位于容器可写层，容器删除后会丢失。运行中 bundle 以 SHA256 固定，升级通过新容器或停止后重新配置完成。

Docker healthcheck 先确认恢复控制器运行，再使用实例内的受限 probe key 完成一次 SSH agent 登录，再请求 `/healthz`。probe key 仅限 loopback、强制执行 `true`，关闭 PTY 与转发。首次 host key 在启动时生成。健康通过表示 SSH 与会话服务可用，模型执行能力由 ACP 验收单独验证。

supervisord 作为 PID 1，直接启动 sshd 与 session-service。事件监听器给每个服务三次累计恢复机会，退避 5、10、20 秒，受 5 秒调度周期影响最多额外等待 5 秒。服务重启成功也消耗预算，第四次退出或 spawn 失败会关闭容器。恢复控制器异常或被杀后关闭容器，单次启动标记阻止控制器被重启时重置预算。Supervisor 的正常 shutdown 可返回退出码 0，调用方必须结合容器 stopped/health 状态判断故障。Agent 任务恢复语义由 session-service 管理。

容器停止时先给 session-service 15 秒宽限期，再给 sshd 5 秒，使用进程组停止并在超时后强制终止。Docker 停止宽限建议至少 25 秒。Agent 创建的独立进程组由 session-service 显式回收。

## 验证

```bash
python3 runtime/scripts/test_bootstrap.py -v
python3 runtime/scripts/test_smoke_cleanup.py -v
python3 runtime/scripts/smoke-image.py
```

前两项覆盖恶意归档、版本、缓存完整性以及准备失败、SIGTERM、Docker 超时和资源删除失败的清理行为。镜像 smoke 使用随机 scope、临时公钥和健康专用测试程序，验证固定 capabilities 下 SSH exec/PTY/SFTP、无 root 登录、agent 无 capabilities、凭据与状态隔离、离线重启、数据保留和有限恢复。测试的 HTTP 下载端点与 SSH 映射使用临时端口监听 0.0.0.0，结束时清理所属容器、卷和凭据。脚本输出明确标注测试程序，仅真实 ACP、Pi 和模型调用可证明 Agent 全链路通过。
