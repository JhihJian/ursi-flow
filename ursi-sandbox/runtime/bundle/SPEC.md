---
parent: ../SPEC.md
depends-on:
  - ./session-service/SPEC.md
  - ./process-supervisor/SPEC.md
references:
  - ../CONTRACT.md
  - ../AGENT-CONTRACT.md
  - ../IMAGE-README.md
---

# runtime bundle

## 功能意图

为 `pi-execution` 环境打包 session-service、监督配置和有限恢复策略，并声明可组合的端点能力。bundle 与镜像分别交付，监督器程序和 Agent CLI 由镜像提供。Gateway 只信任管理员注册的 image -> bundles 关系来开放能力。

## 关键功能与验收

### 包清单与装配

构建脚本接收已构建的 session-service 可执行文件，生成确定性的 `runtime-bundle.tar.gz` 与 `runtime-bundle.sha256`。清单保留 bootstrap 所需的版本、最低镜像级别、`pi-execution` profile 和文件摘要，并统一包含以下能力字段：

```json
{
  "bundles": ["pi-execution"],
  "required_capabilities": ["sshd", "supervisord", "pi-cli"],
  "services": ["sshd", "session-service"],
  "endpoints": [
    {"name": "ssh", "protocol": "ssh", "port": 2222},
    {"name": "agent_session", "protocol": "acp", "port": 8765}
  ],
  "readiness": {
    "ssh": "authenticated exec",
    "agent_session": "GET /healthz"
  }
}
```

`endpoints` 只描述 bundle 提供的逻辑能力，不能含 `address`、`visibility` 或 Gateway key。`--manifest PATH` 和 `--bundles PATH ...` 可把多个定义组合进同一 bundle；每个定义必须明确 `required_capabilities`，端点名和容器端口在组合结果中都不能重复。包包含 `manifest.json`、`bin/ursi-session-service`、`supervisor/supervisord.conf` 和恢复策略脚本。

#### 验收

- 同一输入产生相同归档与摘要，缺少可执行输入时构建失败。
- bootstrap 校验归档摘要与逐文件清单，拒绝不支持的 profile、内容损坏或文件缺失；能力字段不改变既有安全解包校验。
- 包只携带平台程序和策略，监督器来自镜像。
- 更换 bundle 保留工作区，满足基线的镜像可直接启动新包。

### 服务配置

监督配置启用 SSH 与 session-service。服务启动环境遵循独立 Agent 契约，平台凭据通过只读配置目录供 root session-service 读取，再由服务按需向 agent 复制 Pi 配置。

#### 验收

- 当前 `pi-execution` 只有 `ssh`（SSH exec、PTY、SFTP，共用 2222）和 `agent_session`（session-service ACP，内部监听 0.0.0.0:8765）两个端点。browser bundle 使用 image-browser 镜像，额外提供 IDE 和 noVNC 桌面端点。CDP 只监听沙箱回环地址。IDE 和桌面进程以 `agent` 身份运行。
- 健康检查覆盖真实 SSH 登录及 session-service `/healthz`；browser 镜像额外检查 IDE、CDP 和 noVNC 端口。
- 构建产物和服务环境不包含配置凭据、bundle 下载 URL、端点 address、visibility 或 Gateway key。
