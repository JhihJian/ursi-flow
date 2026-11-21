# Pi 执行器部署与会话边界

`ursi-pi-executor-mcp` 在 Linux 上通过 stdio 接收 Workbench 的启动、查询和取消请求。每次尝试使用独立的内存会话。系统指令和 Skill 正文取自发布快照，本次工作指令作为单独的用户消息发送。会话关闭 SDK 内置工具，不从工作区发现扩展、提示模板、`AGENTS.md` 或额外 Skill。

## 启用执行器

构建并安装 `flow-runtime` 后，给 Workbench 服务设置 `URSI_PI_EXECUTOR_BIN`，值为已安装的 `ursi-pi-executor-mcp` 的可执行绝对路径。如果 Node 不在系统 PATH，使用管理员维护的启动器以绝对路径启动 Node。再设置下方的 `URSI_PI_POLICY` 并重启 Workbench。Pi 配置与 Flow 的 `URSI_EXECUTOR_BIN` 独立；未启用 Pi 时，Agent 尝试会被拒绝。

## 部署策略

为 Workbench 和执行器配置相同的 `URSI_PI_POLICY`，例如 `/etc/ursi/pi-policy.json`。将策略放在工作区之外、仅管理员可更换文件的目录中。路径必须为绝对路径，各级均为真实目录。文件必须为单链接的 UTF-8 JSON 普通文件，属主是服务账户或 root，权限为 `0600`，执行器最多读取 1 MiB。两端的服务账户均需能读取该文件。更新时先写好权限为 `0600` 的新文件，再在同一目录原子替换。

```json
{
  "models": [{
    "id": "review-v1",
    "provider": {
      "api": "openai-completions",
      "baseUrl": "https://models.example.org/v1",
      "apiKey": "REPLACE_WITH_MODEL_KEY",
      "model": "review-model",
      "maxTokens": 4096
    }
  }],
  "tools": [{
    "id": "tickets.get",
    "name": "getTicket",
    "url": "https://tickets.example.org/mcp",
    "token": "REPLACE_WITH_READ_ONLY_TOKEN",
    "readOnly": true,
    "inputSchema": {
      "type": "object",
      "properties": {"id": {"type": "string"}},
      "required": ["id"],
      "additionalProperties": false
    }
  }]
}
```

将占位值替换为实际端点、模型名和凭据。`apiKey` 和可选的 Bearer `token` 按字面值使用。远端使用 HTTPS，本机测试可使用 HTTP 回环 IP。地址不带用户名、密码、查询串或片段。只用输入文件的执行器可将 `tools` 设为 `[]`。

在配置包的 MCP 页选择模型 `review-v1` 和工具 `tickets.get` 并保存。执行器发布时只引用该包。省略模型时取策略中首个模型，省略工具时不加载业务工具。模型配置在会话启动时解析，更换模型时应使用新的配置 ID。每个业务工具必须同时匹配快照中的 ID、schema 摘要和当前策略。摘要取递归排序对象键、保留数组顺序的紧凑 UTF-8 JSON 的 SHA-256。每次调用都重新发现工具，核对远端名称和 schema，并在发送 `tools/call` 前重读策略。移除授权会阻止后续调用，已送达服务端的请求无法撤回。`readOnly: true` 是管理员对工具的审核声明，实际读取范围由业务服务和只读凭据控制。

## 运行限制

| 边界 | 执行规则 |
| --- | --- |
| 工作区 | `URSI_EXECUTOR_ROOT` 指向服务账户私有目录。每次尝试的 `agent-config.json` 位于 `workspace/` 之外；`workspace/inputs/` 和 `workspace/artifacts/` 须预先创建为私有目录。文件访问依赖 Linux `/proc/self/fd`。 |
| 快照和指令 | 快照最多 2 MiB。固定指令、每份 Skill 正文和本次工作指令各最多 256 KiB；每版最多 64 个 Skill、64 个业务工具。 |
| 输入 | 只提供 `list_inputs` 和 `read_input` 访问 `inputs/` 下的相对路径。路径最多 64 段，每个目录单次枚举最多 256 项，单文件最多 256 KiB，仅接受有效 UTF-8。读取拒绝符号链接、多硬链接和特殊文件。 |
| 业务 MCP | 协议为 `2025-06-18`。仅支持单个 JSON 响应，通知返回空的 HTTP 202。仅从单页、最多 256 项的 `tools/list` 中按名称精确匹配。调用仅接收文本结果，不跟随重定向或处理 SSE。一次发现与调用合计限时 15 秒，每个请求体和响应体各限 512 KiB，响应头限 16 KiB。 |
| 交付物 | 仅将正常结束的非空最终文本发布为 `artifacts/answer.md`，最多 1 MiB，已有同名文件会使发布失败。工具错误、截断回复或发布前确认取消均不交付部分结果。 |
| 并发与取消 | 每个执行根目录最多 8 个待启动或运行中的尝试，单次会话限时 30 分钟。运行中的取消先发出中止请求，确认中止才记为 `cancelled`；超时并确认中止记为 `failed`。5 秒内未确认则终止会话线程，记为 `unverified`，不自动重发工作指令。 |

这些上限按单文件、单次调用或执行时长计量。进程内存、整次会话的累计 token 费用及远端服务的配额由部署方另行控制。任务状态与目录约定见 [Pi 执行器规格](SPEC.md) 和 [执行器协议](../../../docs/EXECUTOR-MCP.md)。在 Workbench 中登记 Pi 见 [Agent 后端部署配置](../../../workbench/server/src/work/agent_backends/README.md#部署配置)。
