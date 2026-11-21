---
parent: ../SPEC.md
references:
  - ../runtime/CONTRACT.md
---

# 服务 bundle

## 功能意图

管理叠加在 SSH 基线上的服务实现、启动配置与能力定义。构建器从这些输入装配归档，Gateway 从管理员注册表授权访问端点。

## 关键功能与验收

### Pi 与浏览器服务

Pi bundle 提供会话服务和 ACP 端点，browser bundle 追加 IDE 和桌面服务。程序安装在镜像还是归档中由构建规则固定。

#### 验收

- 默认 Pi 组合提供 `ssh` 与 `agent_session`；追加 browser 定义后增加 `ide` 和 `desktop`，CDP 仅监听回环。
- 能力定义不含实例地址、可见性、Gateway key 或模型凭据。
