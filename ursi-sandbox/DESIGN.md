# ursi-sandbox 整体架构

`ursi-sandbox` 交付可供应、可连接、可回收的执行环境。沙箱客户端管理资源并提交任务。角色选择、重试和产物归属由调用方决定，沙箱负责环境和一次执行的状态。

## 三个交付部分

| 交付 | 运行位置 | 状态与接口 |
| --- | --- | --- |
| [Gateway](gateway/CONTRACT.md) | 宿主服务 `ursi-gateway` | HTTP 管沙箱和逻辑端点。管理员注册表决定镜像能力，lifecycle 在 SQLite 记录意图并与 Docker 对账，driver 只报告或改变基础设施。隧道只转发字节。 |
| [Runtime](runtime/AGENT-CONTRACT.md) | 每个沙箱内的环境镜像与 bundle | 镜像提供 Git、Pi、sshd、bootstrap 与 supervisord。bundle 交付 session-service 和监督配置。数据卷保存工作区。 |
| [Client](client/README.md) | 调用方的 Rust 库或 CLI | 调用 Gateway API 和 Runtime 的 ACP WebSocket 子集。文件和普通命令走原生 SFTP/SSH。客户端不拥有远端任务状态。 |

## 从创建到回收

1. 调用方向 Gateway 提交镜像、可选 Runtime 包引用和管理员预置的 `runtime_profile`。操作受理后轮询资源状态。Gateway 根据管理员注册表展开 `image -> bundles`，确定逻辑端点；未注册镜像没有受管端点。容器端口不发布到宿主机。
2. Runtime 校验 bundle 后启动常驻服务。调用方经 SSH/SFTP 准备 Git 工作区，以独立的 Bearer 身份连接 `/acp`，初始化连接并在 `session/new` 指定目录。
3. 首次 `session/prompt` 启动该会话的 Pi 进程。session-service 将 Pi JSONL 转为文本和工具通知，每轮重验目录身份。接受请求不等于成功，只有正常 assistant 终态、Pi 已 settled 且无错误才报告完成。
4. 断线不触发重放。调用方可查询 `_ursi/session/status`，显式取消或关闭会话。每会话监督器回收后代并确认结果。常驻监督器恢复服务，不重放任务。流程级的重试由调用方决定。
5. 停止保留工作区；重建显式选择保留或销毁数据；删除由 Gateway 释放所属容器与卷。清理失败或结果未知保留可核实状态。

## 依赖和信任边界

独立 Cargo workspace、锁文件、镜像和 bundle 均从本目录构建。沙箱不链接 Flow 的领域模型。Pi 适配是 session-service 内部实现；角色和流程遥测由调用方定义。接入方只需公共协议或 client 库，不链接 Gateway driver、会话管理器或 Pi 监督器。

管理员通过 profile 提供最小模型配置、SSH 公钥和会话令牌，不把凭据打进镜像、bundle 或证据。同一沙箱的工具共享 agent 用户；不同信任主体使用不同沙箱。Pi 当前只支持管理员固定模型、文本 prompt、空 MCP 列表和声明的 ACP 子集。IDE、CDP、noVNC 是其他环境可提供的端点，不是 Pi 镜像的依赖。

## 验收边界

独立性用只含本目录的检出构建并打包验证；资源与执行分别用 Docker 黑盒和正式 Pi 验收验证。消费方通过公共契约核验，区分协议接通与业务工作流端到端执行。各轮证据记录实际镜像、bundle 和验证范围。
