---
parent: ../../SPEC.md
references:
  - ./CONTRACT.md
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
