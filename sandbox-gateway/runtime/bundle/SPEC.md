---
parent: ../SPEC.md
depends-on:
  - ./session-service/SPEC.md
  - ./process-supervisor/SPEC.md
references:
  - ../CONTRACT.md
---

# runtime bundle

## 功能意图

打包平台自有程序、脚本与配置，包含 session-service 及其 CLI 适配代码、进程监督配置和启用服务清单。bundle 与环境镜像分别版本化，成熟服务与监督器程序由镜像提供。

## 关键功能与验收

### 包清单与装配

清单记录内容校验值、包版本、最低镜像级别、所需能力、启用服务和就绪检查。bootstrap 验证后将包安装到运行目录，并将配置交给监督器。

#### 验收

- 同一 bundle 的内容和清单可校验，缺少所需能力时启动被拒绝。
- 包中不重复交付镜像已有的监督器程序。
- 更换 bundle 保留工作区，镜像基线满足要求时无需重建镜像。

### 服务配置

配置原生服务端点、agent 会话服务及必要的启动依赖。一个服务可提供多个通道，端点公开策略由 Gateway 控制。

#### 验收

- SSH exec、终端和 SFTP 可共用同一 sshd 服务端点。
- 启用服务的就绪检查与实际功能对应，未启用服务不阻塞就绪。
- 日志与包清单不包含运行凭据明文。
