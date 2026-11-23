# Pi 执行器部署与会话边界

`ursi-pi-executor-acp` 在 Linux 上通过本机 stdio 为执行器平台运行 Pi 会话。它接收 ACP v2 Preview beta.3 JSON-RPC，每行一条 UTF-8 消息。平台负责冻结配置、登记尝试、监督进程及收集制品；Pi 负责实际运行和报告会话状态。部署流程与终态证据见 [ACP 执行契约](../../../docs/design/executor-platform/ACP-PROFILE.md)。

## 启动方式

构建并安装 `flow-runtime` 后，将 `ursi-pi-executor-acp` 的可执行绝对路径登记为平台 Pi 后端。Node 不在启动环境 PATH 时，由管理员维护启动器，以绝对路径启动 Node 和 `dist/pi-executor/acp.js`。标准输出只写 JSONL，启动器日志应写标准错误。

| 环境变量 | 用途 |
| --- | --- |
| `URSI_EXECUTOR_ROOT` | 服务账户的私有执行根目录。生产工作区为 `<root>/<attemptId>/workspace`；通用会话使用根目录下预先创建的私有目录。 |
| `URSI_PI_POLICY` | 管理员维护的模型与只读工具策略，使用绝对路径。 |
| `URSI_ACP_JOB` | 平台为生产尝试生成的私有 `0400` JSON 作业文件，使用绝对路径；预检和通用会话省略此变量。 |

生产作业含 `{cwd, configDigest, nodeContract?}`。`configDigest` 是工作区同级 `agent-config.json` 原始字节的 SHA-256。该快照也是 `0400`，与业务工作区分开；`workspace/inputs/` 和 `workspace/artifacts/` 须预先创建为私有目录。Pi 校验真实路径、文件权限和摘要后才接受生产会话。通用模式选用策略中的首个模型，支持多次文本提交，工具和制品只在生产会话中启用。平台预检仅初始化、建会话和关闭，不提交 prompt。

## 会话与状态

1. `initialize` 传 `protocolVersion: 2` 和客户端 `info`，核对返回版本及 `capabilities.session`。`session/new` 传绝对 `cwd`，可附带 `systemPrompt: {mode,content}`。平台发送冻结系统指令时用文本块，`override` 替换默认指令，`append` 在默认指令之后追加；冻结 Skill 仍独立装配。
2. `session/prompt` 单独提交任务文本。支持 `resource_link` 引用块，引用不会自动读文件或发网络请求。响应的 `messageId` 确认消息已插入，执行结束通过 `session/update` 单独报告。生产会话接受一次插入；仍保留的同一 `idempotencyKey` 返回原 `messageId`，其余新提交被拒绝。
3. `session/cancel` 请求中止前台工作。`session/close` 结束该会话的活动并保留有界的进程内历史。`session/list` 可按 `cwd` 过滤；`session/resume` 使用原 `cwd`，可用 `replayFrom: {type: "start"}` 回放保留历史。Pi 在完成回放后发出 `replay_complete`，并在 resume 响应前同步当前状态。进程退出后，平台按尝试 ID 查询持久记录。

会话关闭 SDK 内置工具，不从工作区发现扩展、提示模板、`AGENTS.md` 或额外 Skill。工具更新只报告名称、状态等协议字段；同一调用使用稳定的 Pi 生成 ID，原始工具参数和输出留在模型执行上下文中。

## 部署策略

为平台和执行器配置相同的 `URSI_PI_POLICY`，例如 `/etc/ursi/pi-policy.json`。策略放在工作区之外、仅管理员可更换文件的目录中。路径各级均为真实目录。文件须为单链接的 UTF-8 JSON 普通文件，属主是服务账户或 root，权限为 `0600`，最多 1 MiB。更新时在同一目录原子替换文件。

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

`apiKey` 和可选的 Bearer `token` 按字面值使用。远端使用 HTTPS，本机测试可用 HTTP 回环 IP。地址不带用户名、密码、查询串或片段。纯输入文件场景将 `tools` 设为 `[]`。

配置包可选模型配置 ID 和业务工具 ID；未选模型时由平台将默认模型 ID 写入快照。业务工具须同时匹配快照的 ID、schema 摘要和当前策略。摘要取递归排序对象键、保留数组顺序的紧凑 UTF-8 JSON 的 SHA-256。每次调用前重新发现工具，核对远端名称与 schema，并在发送 `tools/call` 前重读策略。撤销授权只影响后续调用。`readOnly: true` 是管理员的审核声明，实际读取范围由业务服务和只读凭据控制。ACP 的 `session/new.mcpServers` 不承载此白名单。

## 输入、Skill 和 Flow 制品

- `list_inputs` 和 `read_input` 访问 `inputs/` 下的相对路径。冻结 Skill 的配套文件通过 `read_skill_file({skillId,path})` 读取；文件存在于快照中，完整性由内容摘要校验。有效 UTF-8 返回文本，二进制返回 Base64。
- 普通生产会话成功时写非空最终文本到 `workspace/artifacts/answer.md`。Flow 节点通过作业文件的 `nodeContract` 固定本次 `outcomes` 和 `variables`，例如 `{"outcomes":["通过","退回"],"variables":["摘要"]}`。两个数组各最多 256 项，名称分别唯一；结果至少一项，变量名遵循 [Flow 规范](../../docs/flow-spec.md)。
- 节点用 `submit_flow_outcome` 提交一次结果，例如 `{"outcome":"通过","variables":{"摘要":"材料齐全"}}`。会话正常结束后写入 `workspace/artifacts/flow-outcome.json`，保留变量的 JSON 类型，缺省变量写为 `{}`。漏交、重复提交、非法结果、工具错误、截断或确认取消时不交付部分制品。

| 边界 | 执行规则 |
| --- | --- |
| 快照和指令 | 快照最多 2 MiB。固定指令、每份 Skill 入口正文和任务文本各最多 256 KiB；每版最多 64 个 Skill、64 个业务工具。 |
| 业务输入 | 路径最多 64 段，目录单次枚举最多 256 项，单文件最多 256 KiB，仅接受有效 UTF-8。读取使用 Linux `/proc/self/fd`，拒绝链接和特殊文件。 |
| 业务 MCP | 协议为 `2025-06-18`。单页 `tools/list` 最多 256 项；支持文本结果、单个 JSON 响应和空 HTTP 202 通知响应，无重定向或 SSE。发现与调用合计限时 15 秒，每个请求体和响应体各限 512 KiB，响应头限 16 KiB。 |
| 制品 | 单份最多 1 MiB，已有同名文件时发布失败。 |

进程内存、累计 token 费用及远端服务配额由部署方另行控制。

## 验收

在 `flow-runtime/` 下执行以下命令。集成测试启动构建后的 ACP 程序，使用临时目录和回环模型端点验证协议与制品。跨进程链路由[执行器平台验收](../../../executor-platform/acceptance/README.md)覆盖。

```sh
npm run build
node --test test/pi-acp.test.mjs
```
