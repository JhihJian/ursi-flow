# 沙箱启动契约

## 输入与配对

镜像内 `/ursi/bootstrap` 读取 `URSI_BUNDLE_URL`、`URSI_BUNDLE_SHA256`、`URSI_BUNDLE_MIN_IMAGE_LEVEL`。URL 仅接受 HTTP(S)，摘要是 64 位小写十六进制。镜像提供 sshd、supervisord、bootstrap 及固定的 profile 校验代码。归档提供监督配置、恢复控制器与所选服务。

| 镜像目标 | `manifest.profile` | 镜像级别 | 服务 |
| --- | --- | --- | --- |
| `ssh` | `ssh` | 1 | sshd |
| `pi` | `pi-execution` | 1 | sshd、session-service |
| `browser` | `pi-execution` | 2 | Pi 服务、code-server、浏览器桌面 |

bootstrap 校验 profile 和最低级别。`required_capabilities` 是构建清单的能力声明，bootstrap 不逐项探测第三方程序。额外服务与镜像的匹配由构建者、管理员注册表及服务就绪检查共同保证。Browser 目前基于 Pi 镜像，使用带 browser 定义的 Pi 归档。

## 归档、缓存与工作区

归档是确定性 USTAR + gzip，包含 `manifest.json`、`supervisor/supervisord.conf`、`supervisor/recovery.py` 和所选程序。清单含版本、profile、最低级别、逐文件 SHA256，以及 `bundles`、`required_capabilities`、`services`、`endpoints` 和 `readiness`。端点仅含名称、协议和容器端口。实例地址、可见性、授权与端口转发属于 Gateway。

bootstrap 在临时目录检查归档大小、成员数量、路径、文件类型和摘要。安装位置为 `/opt/ursi/runtime/<sha256>`，原始归档同目录缓存；离线重启仍重新验证归档与已安装树。`/ursi/workspace` 是独立卷，root:agent 1770 及 sticky 位保护 root 状态目录；启动不递归更改既有文件。

## 鉴权、就绪与停止

管理员配置目录 `/run/ursi/config` 必须为 root 私有、只读挂载。所有镜像要求有效 `authorized_keys`，只允许 UID/GID 1000 的 agent 公钥登录。probe 私钥限回环且强制执行 `true`。Pi 镜像另行检查会话 token 与模型配置，详见 [Pi 契约](../bundles/pi-agent/AGENT-CONTRACT.md)。

supervisord 作为 PID 1 管理常驻服务。健康检查先确认恢复控制器与 SSH 登录，镜像扩展再检查自身服务。控制器对所管服务实施有界恢复；停止时按配置发信号、等待并回收进程组。Pi 会话的取消、持久化与工具进程回收由 session-service 负责。
