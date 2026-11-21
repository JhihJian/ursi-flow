---
parent: ../SPEC.md
references:
  - ../../runtime/CONTRACT.md
  - ../README.md
---

# SSH 与 Pi 镜像

## 功能意图

基于 Ubuntu 24.04 提供独立的 SSH 阶段及附加 Pi CLI 的默认阶段，两者共用 sshd、supervisord 和 bootstrap。

## 关键功能与验收

### 镜像级别与依赖

两个目标均为镜像级别 1，镜像中的 profile 确定归档兼容性和启动检查。

#### 验收

- `ssh` 目标提供 Git、SSH、Python、curl、supervisord 和 agent 账户，只声明 2222 端口。
- `pi` 在 SSH 基线上增加 Node.js、Pi 1.5.0 和会话健康检查，额外声明 8765 端口。
- 启动后 agent 以 UID/GID 1000 使用公钥登录，root 与密码登录均被拒绝。
