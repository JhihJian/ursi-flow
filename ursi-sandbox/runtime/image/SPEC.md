---
parent: ../SPEC.md
references:
  - ../CONTRACT.md
  - ../AGENT-CONTRACT.md
  - ../IMAGE-README.md
---

# 沙箱环境镜像

## 功能意图

交付 `pi-execution` 环境 profile，提供 Pi Agent 执行、SSH exec/PTY/SFTP 与应用运行所需的基础工具。镜像提供 bootstrap 和成熟监督器程序，bundle 提供 session-service 与监督策略。

`runtime/image-browser` 在此镜像上交付 `browser` 能力层，包含真实 Chromium、CDP、Xvfb、x11vnc、websockify 和 code-server。只有组合 browser bundle 并注册 `ursi-runtime-browser` 镜像时，IDE、CDP 和桌面端点才会生成。

## 关键功能与验收

### 环境基线

基于 Ubuntu 24.04，提供 Node.js >=22.19、Pi 1.5.0、Git、OpenSSH、Python3、supervisord、curl 与系统证书。镜像声明 `io.ursi.image-level=1`、`io.ursi.environment-profile=pi-execution`。普通执行账户为 agent（UID/GID 1000）。

#### 验收

- 镜像独立构建成功，可查询 Node、Pi、Git、SSH 和监督器版本。
- 在 cap-drop ALL、no-new-privileges 及契约固定的七项 capabilities 下，sshd 和 supervisord 能启动。
- 2222 端口仅支持 agent 公钥认证，root 与密码登录被拒绝，exec、PTY 和 SFTP 正常。
- SSH agent 进程无 effective/permitted/ambient capabilities。

### bootstrap 与缓存

入口 `/ursi/bootstrap` 根据 SHA256 下载并装配 bundle，检查清单与最低镜像级别。归档和解包结果按摘要缓存于 `/opt/ursi/runtime`，每次重启校验归档摘要、已安装路径集合、文件类型、权限及内容摘要。

#### 验收

- 下载内容损坏、清单内容不符、镜像级别过低、路径穿越、重复成员、符号链接、硬链接与特殊文件均拒绝启动。
- 解包成员数与总大小有界，安装采用临时目录与原子发布，已存在的损坏运行包明确报错且不覆盖。
- 有效缓存支持下载服务不可达时重启。

### 工作区、凭据与就绪

配置以 root 私有目录只读挂载到 `/run/ursi/config`。运行目录位于 `/run/ursi`。工作区根采用 root:agent、1770，agent 可创建仓库，sticky 位保护 root 所有的 `.ursi-state`。只准备目录本身的权限，保留既有文件及其所有权。

#### 验收

- 配置缺失、配置目录权限过宽、非只读挂载或 token 太短时启动失败。
- agent 可写工作区，不能读取 session token、读取或替换 `.ursi-state`。
- 停止再启动后仓库与产物保留，既有 root 状态文件仍为 root 所有。
- 镜像健康检查同时完成受限 probe key 的真实 SSH 登录和 session-service `/healthz` 请求。
- browser 镜像额外检查 code-server、CDP 9222 和 noVNC 6080 的实际监听状态。
