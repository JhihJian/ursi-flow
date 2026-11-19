# 预配 ACP 沙箱

当前集成分支的执行计划只支持本地 Agent 适配器。带 `environment:"sandbox"` 的旧执行器发布会被目录拒绝，历史沙箱尝试在执行、查询、取消和人工核实时返回不可用，不会启动 ACP 会话。以下内容是后续迁移所保留的边界记录，不是当前可用配置。

一个 Server 工作存储可接一个预先启动的独占沙箱。管理员将**整个沙箱及其持久卷**分配给一个工作项，且只有这一实例能向该端点派工。普通子目录不是容器内文件访问的权限边界。不同工作项须使用不同沙箱和独立干净卷，不能只改别名、cwd、工作存储或复用旧卷。别名永久标识这次分配。

## 启用

1. 发布 Agent，例如 `{"id":"reviewer","kind":"agent","environment":"sandbox"}`，发布绑定该版本的包并创建工作项，取得工作项 ID。编辑执行器后要发布新包才能改变绑定，原包仍按原环境执行。
2. 为该工作项准备可访问的 ACP 端点和 `/ursi/workspace` 内已经存在的工作目录。管理员确认沙箱工具、模型与工作区权限适合这份材料，端点与 token 均属于该独占沙箱。`ws` 仅用于受保护的内部链路。
3. 在 **Server 的部署环境**设置下表各项并启动或重启 Server。`URSI_SESSION_TOKEN` 必须未设置。缺少配置只禁用沙箱，不影响本地包。工作项、包、执行请求不接受连接参数。

| 环境变量 | 值（示例） |
| --- | --- |
| `URSI_SANDBOX_CLIENT_BIN` | `/opt/ursi/bin/ursi-sandbox-client`，已安装的可信 CLI |
| `URSI_ACP_URL` | `ws://127.0.0.1:8765/acp`，不含身份、query 或 fragment |
| `URSI_SESSION_TOKEN_FILE` | `/etc/ursi/private/session-token`，只放当前沙箱 token |
| `URSI_SANDBOX_CWD` | `/ursi/workspace/review`，路径由远端服务再校验 |
| `URSI_SANDBOX_ITEM_ID` | 此次授权的工作项 ID，必须精确匹配 |
| `URSI_SANDBOX_ALIAS` | `review-01`，1 至 64 个 ASCII 字母、数字、`-` 或 `_` |

CLI 与凭据必须是绝对、无符号链接的普通文件，由服务账户或 root 所有。CLI 必须可执行且无 setuid/setgid 位，禁止组和其他用户写入。凭据仅所有者可访问，例如 `0400` 或 `0600`，服务账户可读，最多 8 KiB。祖先目录也须由服务账户或 root 所有且不可由其他账户写入（root 所有的 sticky 临时目录除外）。凭据不得存放在工作卷内。子进程只接收 ACP URL、凭据文件名及期限，不继承服务端环境。

## 执行与收尾

调用 [尝试 API](API.md) 的 `POST .../attempts` 即可执行。`starting` 时 `backendRunId:null`；`acp new CWD` 返回的 sessionId 随后作为 `backendRunId` 落盘，再调用 `acp prompt ID /dev/stdin`。CLI 通过 `/dev/stdin` 读一次提示文本，不创建具名材料文件。Server 不调用 Gateway、SSH、SFTP、PTY、浏览器或自定义命令。

prompt 限时 5 分钟，控制操作各限时 15 秒。stdout JSONL 上限 512 KiB，只保留本会话的文本消息（最多 64 KiB），不保存工具事件、stderr 或原始协议帧。任务成功要求原 prompt 同时返回退出码 0 和 `end_turn`，并确认 `close`。发出取消通知后，仍须看到原 prompt 退出码 2、`cancelled`，以及相同 sessionId 的 `cancelled`、`pid:null` 状态和关闭回执；若任务先完成则保留实际结果。

`unverified` 表示可能仍在执行，重启或 GET 均不重发。此状态占用沙箱，不能提交下一次尝试。管理员先用部署中的 CLI、端点和凭据文件核查原会话，再显式收尾：

```bash
"$URSI_SANDBOX_CLIENT_BIN" acp status "$SESSION_ID"
# 如需停止，close 会停止运行中的原会话并回收它；确认没有仍需保留的工作。
"$URSI_SANDBOX_CLIENT_BIN" acp close "$SESSION_ID"
"$URSI_SANDBOX_CLIENT_BIN" acp status "$SESSION_ID"
```

确认副作用后，按 [人工核实接口](API.md) 提交 `failed` 或 `cancelled`、证据和原因。Server 用原工作项、原别名再次查询，要求会话 ID 匹配、`state:closed` 且 `pid:null`。`closed` 仅证明回收，不证明任务成功或被取消。没有可信状态时继续占用，勿通过重绑或清库放行。若在 `starting` 阶段重启且没有持久化 sessionId，则尚未发出 prompt；管理员检查可能残留的空会话后可人工核实。

## 可选真实会话验收

仅在已预配的测试工作项和独占沙箱上执行。先让模型返回一个本次唯一的短标记，轮询尝试，检查 `succeeded`、输出标记及环境别名，用 `acp status` 对照同一 sessionId 的最终 `closed` 状态。再启动一个可安全取消的长任务，在远端确认 `running` 后调用取消接口；并发启动另一尝试应返回 409，取消后检查原会话关闭、工具已退出。另一个工作项使用同一包应被拒绝且不产生会话。

在专用测试环境中打断一次在途 prompt 连接，核对 `unverified`、重启后仍是同一 ID、没有第二个 prompt，然后按上述步骤收尾。记录别名、尝试 ID、会话 ID、状态、退出或清理证据，不记录 token 或原始材料。Server 的自动测试使用按 CLI 位置参数和 JSONL 契约实现的模拟程序，不需要预配沙箱。
