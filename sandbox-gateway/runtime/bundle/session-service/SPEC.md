---
parent: ../SPEC.md
depends-on:
  - ../../../agent-cli-adapter/SPEC.md
references:
  - ../../CONTRACT.md
  - ../../AGENT-CONTRACT.md
  - ./README.md
---

# session-service

## 功能意图

沙箱内的 ACP JSON-RPC WebSocket 服务，鉴权后创建绑定工作区的会话，装配 Pi RPC Adapter，管理进程、事件、取消与持久化状态。SSH/SFTP 由独立 sshd 提供。

## 关键功能与验收

### ACP 会话控制

实现协议版本 1 的 initialize、session/new、session/prompt、session/update、session/cancel 及项目 status/close 扩展。每会话仅一个在途 prompt，模型错误由服务返回明确失败。

#### 验收

- `/acp` 要求 Bearer 鉴权，拒绝 Origin、query token 和错误身份。
- 请求 ID 接受整数与字符串，响应与请求一致，未知方法、非法参数、协议错误具有明确错误码。
- cwd canonicalize 后必须为 workspace 内已有目录且位于状态目录之外，非空 MCP 和非文本 prompt 明确拒绝。
- 创建时固定目录句柄。每轮包括复用 Pi 时重新校验请求路径、规范路径及目录设备号/inode，改名、目录替换或 symlink 重定向时拒绝本轮并清理旧 Pi。
- 启动通过固定句柄 fchdir，减少路径重解析竞态。检查边界为请求工作目录完整性，Pi 绝对路径工具与 Bash 的容器文件访问仍受 Linux 权限及容器隔离约束。
- 文本与工具通知按会话关联，prompt 在 Pi 真正停止后返回，模型错误不会被判为成功。
- 在途 prompt 不阻塞同一连接上的取消、状态或其他会话请求，并发 prompt 立即拒绝。

### 权限与配置隔离

root 服务读取管理员只读配置，将必要的 Pi 模型与认证配置写入独立临时目录。生产 Pi 以 UID/GID 1000 运行。工作区顶层 root:1000、01770 保护 root 0700 状态目录，agent 可创建项目目录。

#### 验收

- Pi 使用独立 HOME 与配置目录，环境经 allowlist 重建，不继承服务 token、宿主凭据或 NODE_OPTIONS。
- 模型配置与临时凭据为限权文件，取消、关闭、失败及崩溃恢复后清理。
- 日志和 JSON-RPC 错误不包含提供方原始错误或凭据。
- 普通用户测试可用当前 UID 启动 fake RPC，root 场景验证降权及补充组清空。

### 取消与恢复

取消和关闭终止对应会话的监督进程所管理的全部工具后代。断线保留执行，服务恢复保留可查询的中断状态。

#### 验收

- 取消成功和 close 成功要求监督器零退出码与专用清理回执，回执只能在确认 ECHILD 后发送，其他会话继续可用。
- 监督器 SIGKILL/OOM 或缺少回执时状态为 interrupted，返回明确清理错误，重复 close 和服务重启保留该失败。pid 为 null 仅表示监督器已退出，异常路径可能仍有工具残留。
- detached 工具保持 stdout 打开时，仍及时识别监督器退出。异常收敛不扫描或终止其他会话，遗留工具由外层沙箱停止或删除清除。
- 重连可查询状态和取消，断线不会自动取消或重放 prompt。
- SIGTERM 或服务意外退出后，存活的旧监督进程持锁回收，新服务在锁释放前拒绝启动。锁释放不作为异常监督器已清理后代的证据，恢复的旧 idle/running 会话为 interrupted 且清理结果未确认。
- cancelled/interrupted/closed 会话终止执行能力，继续任务需新建会话。

### 有界服务与健康检查

会话、历史记录、连接、消息、事件队列及任务执行期限使用明确限额，服务初始化完成后提供健康响应。

#### 验收

- 慢客户端队列满或写入超时后断开连接，后台仍可消费事件和响应取消。
- 消息超限、CLI 异常和任务超时返回错误并清理进程。
- `/healthz` 在配置与状态恢复完成后返回成功，默认监听 0.0.0.0:8765。
- 默认容量、超时、状态语义及生产启动前提在 README 中可查。
