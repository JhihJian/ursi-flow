---
parent: ../SPEC.md
references:
  - ./CONTRACT.md
  - ./AGENT-CONTRACT.md
  - ../DESIGN.md
---

# Sandbox Runtime

## 功能意图

提供沙箱环境镜像与平台 runtime bundle。镜像包含基础工具和成熟服务程序，bundle 包含平台自有服务、启动脚本与配置。session-service 管理 agent 会话，process-supervisor 管理沙箱常驻服务进程。

SSH/SFTP 使用 sshd，IDE 使用 code-server，浏览器调试使用 Chromium CDP，桌面使用 noVNC，应用预览访问应用自身端口。这些原生服务独立提供端点，session-service 专注 agent 会话。

## 关键功能与验收

### 环境与运行包交付

image 定义环境和 bootstrap，bundle 定义平台程序与服务配置。启动时校验运行包完整性及镜像能力要求后装配，工作区与运行包分离。

#### 验收

- 合法镜像与 bundle 组合能够启动指定服务，非法组合返回明确错误。
- 只修改平台程序或启动配置时可重新交付 bundle，无需重建环境镜像。
- 装配运行包不覆盖已有工作区数据。

### 服务与会话管理

成熟监督器根据 bundle 配置启动常驻服务，session-service 通过 Agent CLI Adapter 启动、控制和回收 agent 会话进程。

#### 验收

- SSH/SFTP 可独立使用，执行普通命令无需创建 agent 会话。
- agent 会话能够执行、回传事件并接受取消，关闭后会话子进程被回收。
- 常驻服务崩溃可按策略恢复，agent 任务不会因服务恢复被自动重放。

### 独立 Agent 执行

运行环境通过 Gateway、SSH/SFTP 和 ACP 对外提供完整执行能力。独立客户端可准备仓库、驱动真实 Pi CLI、读取产物并验证结果，运行链路无需启动 server、FSM 或 Web。

#### 验收

- 正式镜像与 bundle 配合真实模型，能够修改 Git 工作区并通过独立执行的回归测试。
- 取消返回成功时，对应 CLI 与工具后代已被回收，另一会话可继续运行。
- 沙箱停止后启动保留工作区，删除后所属容器与数据卷被清理。
