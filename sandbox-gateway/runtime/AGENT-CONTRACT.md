# 独立沙箱 Agent 执行契约

## 交付与调用链

Gateway 管资源，Runtime 镜像与 bundle 启动 sshd 和 session-service。独立客户端使用 SSH/SFTP 准备仓库，通过 ACP WebSocket 创建会话并驱动 Pi RPC。首个 CLI 为 `@earendil-works/pi-coding-agent@1.5.0`，RPC 支持已在真实模型调用中确认。

## 运行目录与配置

- 镜像标签 `io.ursi.image-level=1`，环境包括 Node.js >=22.19、Pi 1.5.0、Git、OpenSSH、Python3、supervisord、curl 和证书。
- 入口 `/ursi/bootstrap`。`/ursi/workspace` 是 Gateway 命名数据卷，普通执行用户为 `agent`（UID/GID 1000）。`/run/ursi` 是运行时临时文件区，不放进工作区。
- Gateway `runtime_profile` 可选字符串指向管理员白名单。配置目录以只读方式挂载 `/run/ursi/config`，API 不能指定任意宿主路径、capabilities 或 env。profile 配置由 `URSI_GATEWAY_RUNTIME_PROFILES` 指向 JSON 文件，格式 `{ "pi": { "config_dir": "/absolute/private/config" } }`。
- 配置目录包含 `session-token`（Bearer token，至少32字符）、`authorized_keys`（SSH公钥）、`pi/models.json`、可选 `pi/auth.json`、`session.json`。`session.json` 为 `{ "provider":"...", "model":"..." }`。凭据不放入镜像、bundle、API响应或SQLite。Agent 不能以root运行，session token不下发给CLI。
- 有 runtime_profile 的 Docker 沙箱允许管理员固定的 SSH/降权所需能力 `CHOWN,DAC_OVERRIDE,FOWNER,SETUID,SETGID,SYS_CHROOT,KILL`，继续 cap-drop ALL、no-new-privileges，无特权模式或Docker socket。无 profile 时保持原来的全能力移除策略。
- SSH 在 `0.0.0.0:2222`，仅 agent 公钥登录，SFTP使用同端点。session-service 在 `0.0.0.0:8765`，提供 `/healthz` 与 `/acp`。session端点默认 internal。健康检查须同时确认 sshd 就绪与 session-service可接收请求。

## Runtime bundle

bundle 是 gzip tar 包，目录布局为 `manifest.json`、`bin/ursi-session-service`、`supervisor/supervisord.conf` 及平台脚本。清单至少含 `{ "version":"...", "min_image_level":1 }`。构建脚本输出 tar 包及 SHA256，Gateway 的 `bundle` 引用按既有 URL/SHA256/min_image_level 透传。

bootstrap 下载到临时文件，校验SHA256、清单级别及安全解包路径，安装到 `/opt/ursi/runtime/<sha256>/`。运行中包不可被覆盖。启动成功后使用校验通过的缓存可支持无网络重启。镜像无 bundle 或有效 profile 时明确失败，不启动无鉴权服务。监督器只重启常驻服务，不重放已失败的 agent 任务。

## ACP 子集

`GET /acp` WebSocket 要求 `Authorization: Bearer <session-token>`，拒绝 Origin、query token 和错误身份。使用 JSON-RPC 2.0，协议版本 1。请求ID为字符串或整数；未知方法返回 -32601，参数错误 -32602，业务失败使用 -32000 类错误且不含凭据。

- `initialize`：params `{ "protocolVersion":1,"clientCapabilities":{} }`。result包含 `protocolVersion:1`、`agentInfo`、`agentCapabilities`，如 `loadSession:false`。
- `session/new`：params `{ "cwd":"/ursi/workspace/repo","mcpServers":[] }`。cwd必须为已存在且规范化后位于workspace内的目录。result `{ "sessionId":"..." }`。首版非空mcpServers明确拒绝，不静默忽略。
- `session/prompt`：params `{ "sessionId":"...", "prompt":[{"type":"text","text":"..."}] }`。结果直到该任务真正停止才返回 `{ "stopReason":"end_turn" }`，取消返回 `cancelled`。模型/CLI错误返回JSON-RPC error，不能只因agent_settled就判定成功。每会话仅一个在途prompt，不静默排队或重放。
- `session/update` 通知：params `{ "sessionId":"...", "update":{ "sessionUpdate":"agent_message_chunk", "content":{"type":"text","text":"..."} } }`；工具事件使用 ACP `tool_call` / `tool_call_update`，保留toolCallId、title、status与必要content。
- `session/cancel`：通知 `{ "sessionId":"..." }`。终止对应CLI进程组及工具子进程，prompt返回cancelled后无该执行遗留进程，其他会话继续可用。
- `_ursi/session/close`：请求，关闭并回收指定会话，result `{}`。这是本项目扩展，不冒充标准ACP方法。
- `_ursi/session/status`：请求，result至少含 `{ "sessionId":"...", "state":"idle|running|cancelled|interrupted|closed", "pid":null或进程PID }`，用于独立验收进程回收和会话中断。状态不能包含凭据或完整CLI命令。

断开连接不重放、不自动取消会话。重连同一沙箱身份可查询会话状态。服务重启后未完成会话标记interrupted；会话数据状态记录不在仓库输入输出目录中。会话数量、事件缓冲、消息大小和执行时长均有界，具体默认值在实现文档中说明。

## Pi Adapter

使用官方 `pi --mode rpc --no-session`，独立 `PI_CODING_AGENT_DIR`，默认禁止自动加载宿主/项目扩展、MCP和上下文资源。通过stdin JSONL发送prompt，持续读取stdout事件，直到 `agent_settled` 才结束，结合message stopReason/error判断结果。禁止把 `prompt success:true` 或 `agent_end` 单独当作任务成功。

Pi进程在会话工作区以agent用户运行，独立进程组。支持显式abort，超过取消宽限后终止进程组。凭据只复制需要的Pi配置到限权运行目录，CLI环境不继承session token。解析严格按LF拆帧，处理stderr、子进程异常退出、超时和背压。

## 独立验收

真实验收使用管理员提供的最小Pi配置、真实模型和临时SSH key。启动Gateway、发布bundle、创建正式Runtime沙箱，经SFTP上传Git仓库，通过ACP要求Pi修改函数并补测试；独立客户端读取文件差异和执行测试验证结果。再验证两会话互不影响、取消后工具进程清理、停止/启动后仓库保留、最后删除无残留资源。模型调用失败应准确报错，不能用fake替代真实执行通过记录。
