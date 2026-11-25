---
parent: ../../SPEC.md
references:
  - ../../../bundles/pi-agent/AGENT-CONTRACT.md
  - ../../README.md
---

# ACP 会话消费方

## 功能意图

在通用沙箱端点之上驱动 Agent 会话。CLI 通过 Gateway bridge 连接 ACP WebSocket；Agent 的 JSON-RPC 消息、会话身份、终态判定和退出码由本模块负责。

## 关键功能与验收

### 可选会话控制

Cargo feature `acp` 默认启用，提供 `acp` 子命令和 `acp::{Acp, PromptOutcome}` 库 API。

#### 验收

- 默认 CLI 保留 `initialize`、`new`、`prompt`、`status`、`cancel`、`close` 和 JSONL 输出，库根保留 `Acp`、`PromptOutcome` 入口。
- Gateway Bearer 用于外层 bridge。Pi 会话 token 仅用于内层 ACP 握手，取自环境变量或文件，客户端过滤对端回显的凭据。
- 通知和不匹配 ID 的响应不结束当前请求；多个通知不延长请求总期限。prompt 的 `end_turn` 和 `cancelled` 分别返回 0 和 2，远端错误、未知终态、断线和超时返回 1，不重放任务。
- fake 对端可验证通过另一连接取消在途 prompt、查询状态并关闭会话。

### 真实 Pi 验收

使用独立 Gateway、正式镜像与 bundle、管理员最小模型配置，对运行中的 Agent 做端到端验证。

#### 验收

- 入口要求 root 并显式 opt-in，只复制指定配置文件到 root 私有目录。验收在独立 scope 注册镜像和 bundle，SSH/SFTP 与 ACP 均走命名端点。
- Pi 修改函数并补测试，收到 `end_turn` 后通过 SSH 独立核对差异、运行测试，并验证新增测试能识别原 bug。
- 观察真实长工具启动，通过 `/proc` 核对 root 监督器与工具父子进程身份及存活。`cancelled` 返回时已记录的 PID 和标记后代立即消失，读取证据失败即验收失败；另一会话仍能完成任务。
- 停止再启动保留仓库文件与测试；删除后无所属容器和卷。等待有期限，失败时清理自身 scope，并在仓库外保留脱敏阶段、命令类别和退出码，排除凭据、模型配置、prompt 和原始输出。
