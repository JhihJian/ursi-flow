# 沙箱管理模块设计

## 三个职责边界

Gateway 管沙箱资源，Runtime 管沙箱内进程与 agent 会话，Server Channel 管连接。目录按职责组织，crate 按编译边界组织，服务进程按运行位置组织。

| 边界 | 运行位置与交付形式 | 职责 |
|---|---|---|
| Sandbox Gateway | 独立服务，一个 Rust crate | 资源生命周期、持久化对账、端点与暴露策略、可选字节隧道 |
| Sandbox Runtime | 沙箱内环境镜像与平台 bundle | 系统环境、服务启动、agent 会话与进程回收 |
| Server Channel | server 内的连接库，一个 Rust crate | 直连或隧道连接、SSH/SFTP、ACP 传输、HTTP/WebSocket 代理 |

## 目录与模块

路径均相对于仓库根目录。下列职责目录各有 SPEC.md，普通源码文件在所属模块规格中描述。

| 目录 | 内容 |
|---|---|
| `sandbox-gateway/gateway/` | Gateway crate 与跨模块契约 |
| `sandbox-gateway/gateway/src/gateway_api/` | gateway-api：HTTP 接入、认证、请求与响应映射 |
| `sandbox-gateway/gateway/src/lifecycle/` | 资源编排、操作意图、SQLite 存储、启动与周期对账 |
| `sandbox-gateway/gateway/src/driver/` | 基础设施适配接口、Docker 实现与测试替身 |
| `sandbox-gateway/gateway/src/tunnel/` | 可选 TCP over WebSocket 字节中继 |
| `sandbox-gateway/runtime/image/` | 环境镜像、bootstrap、系统工具与成熟服务程序 |
| `sandbox-gateway/runtime/bundle/` | 平台运行包、清单、脚本与服务配置 |
| `sandbox-gateway/runtime/bundle/session-service/` | agent 会话服务与 Agent CLI Adapter 装配 |
| `sandbox-gateway/runtime/bundle/process-supervisor/` | 成熟监督器的配置、启动依赖与停止规则 |
| `server/crates/channel/` | 服务端连接库，各协议在同一 crate 内组织 |
| `sandbox-gateway/agent-cli-adapter/` | 沙箱内 CLI 适配、能力渲染与 Pi 进程监督，由 session-service 装配 |
| `sandbox-gateway/sandbox-observe/` | 观测契约与采集接口，由现有事件生产方接入 |

Gateway 内部调用方向为 gateway-api → lifecycle / tunnel，tunnel → lifecycle，lifecycle → driver。models 为 crate 内共享数据结构，store 属于 lifecycle，不单独建立 crate。

CLI Adapter 与 sandbox-observe 按沙箱子系统归属放在 `sandbox-gateway/` 下，保持独立库 crate。Adapter 继续依赖共享 domain 与 agent-runtime 契约，观测库供服务端和沙箱侧接入事件。

Runtime 的 session-service 是平台自有服务。sshd、code-server、Chromium 和 noVNC 使用各自原生服务。process-supervisor 复用成熟监督器，程序安装在镜像中，配置与薄适配放在 bundle 中。监督器选型依据进程回收、退出处理和就绪能力验证确定。

## 谁拥有资源

| 对象 | 唯一管理方 | 调用关系 |
|---|---|---|
| 沙箱资源与操作意图 | Gateway lifecycle | server 请求创建或释放，driver 执行基础设施操作 |
| 容器、Pod、卷等基础设施 | driver 执行并报告实际状态 | lifecycle 决定业务状态与重试策略 |
| 沙箱内常驻服务进程 | process-supervisor | 根据 bundle 配置启动、保活、停止 |
| agent 会话及其 CLI 子进程 | session-service | Agent Runtime 请求创建、执行、取消、关闭 |
| 本地连接 | Channel | 关闭连接或请求关闭会话，对端负责资源回收 |
| 工作流重试与返工 | server engine | agent 失败作为执行结果回传，由流程决定后续动作 |

连接中断不等同于会话取消。session-service 根据显式关闭、到期或沙箱停止处理会话清理；Channel 将连接状态报告调用方。服务进程重启不得静默重放 agent 任务。

## 镜像与 bundle

镜像包含操作系统、Git、Agent CLI、sshd、code-server、Chromium、noVNC、成熟监督器和 bootstrap。bundle 包含 session-service 程序、CLI 适配代码、启动配置与平台脚本。启用的服务由环境配置选择，bundle 声明所需环境能力和最低镜像级别。

bootstrap 校验 bundle 完整性与环境要求后装配服务。监督器程序只由镜像交付，监督配置只由 bundle 交付。工作区数据与运行包分别管理，更新 bundle 不覆盖工作区。

## 通道与端点

命令和终端使用 SSH，文件使用 SFTP，agent 会话使用 ACP，其他服务使用原生 HTTP/WebSocket。SSH exec、终端和 SFTP 可以复用同一 sshd 端点，通道与端口无需一一对应。

Channel 根据端点描述选择直连或 Gateway 隧道。隧道只转发字节，上层协议与服务端鉴权保持一致。内部端口仅经受控网络或鉴权隧道访问，Gateway 不提供将内部端口临时公开的旁路。应用预览可申请公开端点，但必须经过公开端点策略校验。

## 参考与验证边界

参考 `/data/github/grasp/sandbox-gateway/` 的资源生命周期、驱动、传输与运行包设计，提取适用的行为用例。每个功能记录参考用例与本项目差异，以本项目契约为验收依据，不承诺整个 Grasp HTTP API 兼容。

Gateway 以独立二进制实现控制面、Docker 驱动与可选隧道，验证入口见 [Gateway 使用说明](gateway/README.md)。Runtime 和 Server Channel 的实现进度分别跟随自身模块，Gateway 验收镜像仅用于资源与传输验证。Docker 是首个真实驱动，fake 用于故障注入与契约测试。Kubernetes/E2B 扩展现有 driver 边界，不提前建立空驱动工程。
