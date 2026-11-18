---
parent: ../SPEC.md
references:
  - ../runtime/AGENT-CONTRACT.md
  - ../gateway/CONTRACT.md
  - README.md
---

# 独立沙箱客户端

## 功能意图

以独立调用方身份接入 Gateway 和沙箱 ACP 服务，验证沙箱 Agent 执行能力，脱离 server、工作流和 Web 页面使用。

## 关键功能与验收

### 独立控制与仓库访问

提供独立 CLI 与库 API，经 Gateway HTTP 创建、查询、启动、停止和删除沙箱，经 agent 公钥 SSH/SFTP 准备和读取仓库。

#### 验收

- Gateway 身份和 session token 由环境变量或文件提供，URL 和 argv 不携带凭据，输出过滤已知身份。
- HTTP 202 保留受理状态，由调用方查询实际完成状态，错误具有明确非零退出码。
- SSH 禁用密码认证，使用独立 known_hosts 和指定私钥，每次操作有期限。

- 主用户验收只通过 `ursi-sandbox-client` 操作沙箱，不通过 Python 脚本执行。新建沙箱并等待就绪，通过 SSH 在空工作目录编写 `index.html`，通过 SFTP 下载并核对 SHA-256。删除后确认 404，下载页面在浏览器中显示 `Hello World`。

### ACP 任务与会话控制

使用 ACP WebSocket 初始化、创建会话、提交 prompt、接收必要消息和工具事件，支持取消、状态查询和关闭会话。

#### 验收

- 通知和不匹配 ID 的响应不结束当前请求，多个通知后仍等待相同 ID 的最终结果，通知不延长总期限。
- prompt 只有 end_turn 返回成功，cancelled 使用独立退出码，JSON-RPC error、未知终态、断线与超时均报错且不重放。
- 另一个连接可以取消当前在途 prompt，并继续查询状态、关闭会话。
- fake 对端测试覆盖传输与终态语义，真实模型验收显式 opt-in。

### 真实 Pi 独立验收

启动随机 scope 的独立 Gateway，发布正式 bundle，使用正式 Runtime 镜像和操作方最小模型配置完成仓库任务。

#### 验收

- 真实 Pi 修改函数并补测试，ACP end_turn 后独立检查差异与测试，新增测试能够检测原 bug。
- 观察真实长工具启动后，通过 `/proc` 核对 root 监督器与工具父子进程身份及存活，不以跨 UID 信号权限判断存活。收到 cancelled 时记录的 PID 和标记后代立即消失，进程证据读取失败则验收失败，另一会话继续完成真实任务。
- 停止再启动保留仓库文件与测试，Gateway 删除后无所属容器和卷。
- 所有等待有期限，失败时清理自身 scope 并保留仓库外脱敏证据。证据包含取消子阶段、固定客户端命令类别和退出码，不记录命令参数、凭据、模型配置、prompt 或原始输出。
- 真实验收默认忽略，必须显式启用并提供 Gateway binary、镜像、bundle 和操作方最小 Pi 配置。入口要求 root，保证临时配置归 root 所有且权限为 0700，仅复制指定文件，不读取宿主全量 auth。
