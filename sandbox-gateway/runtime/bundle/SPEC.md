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

为 `pi-execution` 环境打包 session-service、监督配置和有限恢复策略。bundle 与镜像分别交付，监督器程序和 Agent CLI 由镜像提供。

## 关键功能与验收

### 包清单与装配

构建脚本接收已构建的 session-service 可执行文件，生成确定性的 `runtime-bundle.tar.gz` 与 `runtime-bundle.sha256`。清单包含版本、最低镜像级别、环境 profile、文件摘要、服务清单和就绪条件。包包含 `manifest.json`、`bin/ursi-session-service`、`supervisor/supervisord.conf` 和恢复策略脚本。

#### 验收

- 同一输入产生相同归档与摘要，缺少可执行输入时构建失败。
- bootstrap 校验归档摘要与逐文件清单，拒绝不支持的 profile、内容损坏或文件缺失。
- 包只携带平台程序和策略，监督器来自镜像。
- 更换 bundle 保留工作区，满足基线的镜像可直接启动新包。

### 服务配置

监督配置启用 SSH 与 session-service。服务启动环境遵循独立 Agent 契约，平台凭据通过只读配置目录供 root session-service 读取，再由服务按需向 agent 复制 Pi 配置。

#### 验收

- SSH exec、PTY、SFTP 共用 2222 端口，session-service 在 0.0.0.0:8765 启动。
- 健康检查覆盖真实 SSH 登录及 session-service `/healthz`，IDE/CDP/noVNC 不参与此 profile 的就绪判断。
- 构建产物和服务环境不包含配置凭据与 bundle 下载 URL。
