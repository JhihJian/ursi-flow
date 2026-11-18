# 沙箱运行环境契约

## 交付边界

镜像提供系统工具、Agent CLI、sshd、code-server、Chromium、noVNC、成熟监督器与 bootstrap。bundle 提供 session-service（含 CLI Adapter）、平台脚本、监督配置和服务清单。每种程序只有一处交付来源，监督器程序在镜像，监督配置在 bundle。

bundle 清单包含版本、内容校验值、最低镜像级别、所需环境能力和服务就绪条件。bootstrap `/ursi/bootstrap` 校验后装配服务，校验失败不启动业务进程。运行时具备 bundle 装配能力，在线更换是否需要停止会话由更新操作明确约束，不能覆盖正在使用的程序。

`pi-execution` 环境能力包含 SSH/SFTP 与 ACP，交付入口见 [Runtime 使用说明](README.md)，执行协议见 [Agent 契约](AGENT-CONTRACT.md)。下表定义各环境能力的服务归属，具体启用集合由镜像与 bundle 声明。

## 对端服务

| 通道 | 对端 | 资源管理方 |
|---|---|---|
| SSH 命令与终端 | sshd，exec 或 PTY | sshd 管连接进程，调用方控制命令 |
| SFTP | 同一 sshd 的 SFTP 子系统 | sshd |
| ACP | session-service | session-service 管会话和 CLI 子进程 |
| IDE | code-server 原生 HTTP/WebSocket | code-server |
| 浏览器调试 | Chromium CDP | 浏览器服务及其启动配置 |
| 桌面 | noVNC 与后端 VNC 服务 | 桌面服务及其启动配置 |
| 应用预览 | 应用原生 HTTP/WebSocket | 启动该应用的运行或会话 |

具体端口由环境配置声明，Gateway 返回运行实例端点。多个通道可以共用一个端点。公开/内部策略见 [Gateway 契约](../gateway/CONTRACT.md)。Channel 可直连或经隧道访问，服务侧身份校验仍须执行。

## 就绪与停止

就绪检查覆盖启用的必需服务。SSH/SFTP 就绪验证实际连接能力，session-service 就绪验证会话服务可接收请求，单一 TCP 端口开放不代表所有服务就绪。

监督器只负责常驻服务保活，session-service 管 agent 执行进程。连接断开、会话取消、任务失败、服务退出分别报告，服务恢复不自动重放任务。沙箱停止按监督配置传递信号并回收子进程。

## 工作区与凭据

Gateway 挂载根为 `/ursi/workspace`。调用方负责组织挂载根下的业务目录、输入与产物。独立客户端可直接在挂载根下准备 Git 项目，session-service 校验目录归属并排除私有状态目录。工作区保留策略由 Gateway 管理的存储资源落实，bundle 装配不清空工作区。

凭据通过受控运行时注入，按 CLI 或服务需要采用环境变量或限权临时文件。凭据不写入镜像、bundle 或普通元数据日志，临时凭据随会话或沙箱释放清理。读取、传输和观测路径均执行访问范围校验与敏感信息过滤。
