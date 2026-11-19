# ursi-flow-runtime

独立 Node 包，直接运行带固定 `FLOW.md` 入口的目录。需要 Node.js 22.19+；Agent 节点还需要可用的模型 provider 配置（`baseUrl`、`apiKey`、`model`）。本地模式会在当前用户权限下运行包中的命令，只运行信任的包。

从 `flow-runtime/` 安装可执行文件，然后可运行独立示例：

```sh
npm ci && npm run build && npm install -g .
ursi-flow-local check examples/ordinary
ursi-flow-local run examples/ordinary --variables '{"任务":"评审改动"}'
```

`--base-url`、`--api-key`、`--model` 指定 provider（也可用 `URSI_FLOW_BASE_URL`、`URSI_FLOW_API_KEY`）。`--cwd` 指定业务项目，`scripts/` 仍相对包根解析。默认历史文件是业务目录的 `.ursi-flow/history.json`，用 `--history` 可修改。加 `--trajectories <目录>` 时，每次 Agent 节点执行会在该目录留下 `<节点执行 ID>.jsonl` 的 Pi 会话切片，可直接用轨迹查看器打开。测试用本地 OpenAI 兼容服务模拟模型响应，不消费模型额度。`npm pack` 生成可独立安装的压缩包，安装后用 `ursi-flow-local check|run` 做单次执行。常驻管理服务 `ursi-flowd` 管理流程包、后台运行、配置和历史。[独立控制台](web/README.md) 是同一 daemon 的浏览器入口，构建产物可单独发布或嵌入工作台。[Rust Server](../workbench/server/README.md) 自动启动和关闭自己的 daemon，通过 `FlowClient` 与它通信。仅使用 [独立 CLI](client/README.md) 时可自行启动 daemon。

## 以服务方式运行

daemon 用 Pi SDK 在进程内执行 Agent 节点，不再调用外部 `pi` 命令，因此不需要 `PATH` 或 `URSI_FLOW_PI`。模型接入完全由 `~/.ursi-flow/config.json` 的 `provider` 决定（控制台“运行配置”页可编辑）：

```json
{
  "executor": "local-pi",
  "provider": {
    "baseUrl": "https://api.example.com/v1",
    "apiKey": "sk-...",
    "model": "example-model",
    "api": "openai-completions"
  },
  "maxConcurrent": 4
}
```

- 适配器不读取全局 Pi 的 `auth.json`、`models.json`、扩展和 Skills，provider 是唯一来源，因此任何用户的凭据与模型目录都能用同一份配置接进来。
- `baseUrl` 填服务根地址（OpenAI 兼容服务一般到 `/v1`），`api` 选协议：`openai-completions`、`openai-responses`、`anthropic-messages`、`google-generative-ai`。
- 可选 `contextWindow`、`maxTokens`、`reasoning`、`thinkingLevel`。
- provider 缺字段时 `run.start` 直接返回 `invalid_request` 并列出缺项，控制台会禁用“启动运行”按钮并在页面提示缺什么。
- `config.json` 含明文密钥，权限保持 `0600`。
- daemon 把每次 Agent 节点执行的会话切片写到 `~/.ursi-flow/runs/<runId>/trajectories/<节点执行 ID>.jsonl`，与 `facts.json` 同目录。`run.trajectory` 按节点执行读取切片，超过 8 MiB 只返回大小；`run.flow` 按运行持有的目录修订读取包，Flow 之后被改动或删除不影响已完成的运行。

## 项目边界

- `src/core/definition`、`execution`、`state`、`contracts`：包发现与解析、结果边路由、运行记录、调用契约。SDK 使用 `ursi-flow-runtime/core`。
- `src/ability`：Agent 的创建与复用、每次节点执行独立的结果提交工具和能力协议。解析器、Core、Ability 与 [Flow 规范](docs/flow-spec.md) 引自 MIT 授权的 Agent-Flow-Runtime `e4ea1ee52c91a039676f8673baf939f83dad9146`。定义以源码和参考 fixtures 验收。
- `src/executor-adapters/local-pi`：用 Pi SDK 在进程内创建 Agent 会话，provider 由运行配置注入。新 Agent 使用独立会话，复用节点在同一会话上继续。会话可用内置工具读写工作区，但只有显式的 `submit_flow_outcome` 工具回执参与路由；模型连续三次提交非法结果时本轮直接结束，避免无限重试。命令、文件历史、并行及子 Run 装配也由本地主机提供。本版适配器不启用 Pi 扩展、Skill 与 Profile，声明业务工具或要求接管既有会话会被拒绝。
- `src/integrations/mcp`：[集成边界说明](src/integrations/mcp/README.md)。MCP 和 Gateway 执行器尚未提供。
