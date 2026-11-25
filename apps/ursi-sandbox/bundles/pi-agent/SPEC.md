---
parent: ../SPEC.md
depends-on:
  - ./session-service/SPEC.md
references:
  - ./AGENT-CONTRACT.md
  - ./README.md
---

# Pi Agent bundle

## 功能意图

在 SSH 环境中增加 Pi RPC 会话执行能力；目录名为 `pi-agent`，归档 profile 和注册标识保持 `pi-execution`。

## 关键功能与验收

### Pi 配置与会话服务

镜像安装 Pi CLI 与专有检查，归档安装 ACP session-service 并在监督器下启动。会话服务校验配置并管理工具后代。

#### 验收

- 缺少可执行会话服务、模型配置或会话 token 的 Pi 环境启动失败。健康检查要求 SSH 就绪且 `/healthz` 成功。
- 已鉴权的 ACP 调用可以创建会话、执行和取消任务，详见会话服务规格。
