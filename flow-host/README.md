# ursi-flow-host

Flow 的进程宿主：常驻 daemon `ursi-flowd`、单次运行 CLI `ursi-flow-local`、MCP adapter `ursi-flow-executor-mcp`、本机包目录与运行登记、本地 Pi 与平台执行器适配，以及 Rust 客户端 SDK/CLI。

推进语义属于 [ursi-flow-runtime](../flow-runtime/README.md)。宿主负责进程、Socket、凭据、包修订与执行器绑定，并通过同一条 Unix socket 协议把能力交给 Workbench、CLI 与 MCP 客户端。

## 组成

| 目录 | 职责 |
| --- | --- |
| `src/machine` | daemon 协议、包目录与原子修订、运行登记与 worker 监督、运行配置 |
| `src/executor-adapters/local-pi` | 用 Pi SDK 在进程内创建会话，回收节点结果，写会话轨迹切片 |
| `src/executor-adapters/platform` | 按执行器修订调用平台 v2 API，保存与核实 `attemptId` |
| `src/ability` | Agent 创建与复用、结果提交工具、Profile 装配协议 |
| `src/core` | 宿主当前的运行协调器：命令节点、并行、子 Flow、恢复与事实存储 |
| `src/integrations/mcp` | 整条 Flow 的 MCP stdio adapter |
| `client` | Rust `FlowClient` 与 `ursi-flow` CLI |

`src/core` 是待收敛的一层：它实现的路由、并行与子 Flow 能力超出了 Flow Core 目前能表达的范围。收敛方向是把这些能力补进 Flow Core 与引擎，而不是继续在宿主里保留第二套推进逻辑，详见[精简运行时设计](../docs/design/flow-runtime/RUNTIME.md)。

## 构建

```sh
(cd ../flow-core && npm ci && npm run build)
(cd ../executor-sdk && npm ci && npm run build)
npm ci && npm run build
```

单次运行示例：

```sh
npm install -g .
ursi-flow-local check ../flow-runtime/examples/ordinary
ursi-flow-local run ../flow-runtime/examples/ordinary --variables '{"任务":"评审改动"}'
```

`--base-url`、`--api-key`、`--model` 指定 provider（也可用 `URSI_FLOW_BASE_URL`、`URSI_FLOW_API_KEY`）。`--cwd` 指定业务项目，`scripts/` 仍相对包根解析。默认历史文件是业务目录的 `.ursi-flow/history.json`，用 `--history` 可修改。加 `--trajectories <目录>` 时，每次 Agent 节点执行会在该目录留下 `<节点执行 ID>.jsonl` 的 Pi 会话切片。

## 以服务方式运行

`ursi-flowd` 默认用 Pi SDK 在进程内执行 Agent 节点，模型接入完全由 `~/.ursi-flow/config.json` 的 `provider` 决定（可用 `ursi-flow config set` 修改）：

```json
{
  "executor": "local-pi",
  "provider": {
    "baseUrl": "https://api.example.com/v1",
    "apiKey": "sk-...",
    "model": "example-model",
    "api": "openai-completions"
  },
  "maxConcurrent": 4,
  "workspace": "/srv/flow-workspaces"
}
```

- 适配器不读取全局 Pi 的 `auth.json`、`models.json`、扩展和 Skills，provider 是唯一来源。
- `baseUrl` 填服务根地址（OpenAI 兼容服务一般到 `/v1`），`api` 选协议：`openai-completions`、`openai-responses`、`anthropic-messages`、`google-generative-ai`。
- 可选 `contextWindow`、`maxTokens`、`reasoning`、`thinkingLevel`。
- 本地模式启动需要完整的 provider，缺失时启动请求直接报出缺哪几项；平台模式可独立启动。
- `workspace` 是工作区根目录。`run.start` 不带 `cwd` 时，daemon 在 `<workspace>/<Run ID>` 新建目录作为这次运行的工作目录；两处都没有时返回 `invalid_request` 并提示去配置。显式 `cwd` 必须是已存在的绝对路径，仍优先于工作区。工作目录在启动时写进 Run 记录，同一 Run ID 重试要求 Flow、目录与变量一致，否则返回 `conflict`。
- `config.json` 含明文密钥，权限保持 `0600`。
- 已发布的包位于 `~/.ursi-flow/versions/v1/<Flow ID>/`。`v1` 是 Flow 规范格式版本，发布时原子切换到 `.revisions/` 下的新快照。使用 CLI 发布，已发布目录只读使用。
- daemon 把每次本地 Pi 节点执行的会话切片写到 `~/.ursi-flow/runs/<runId>/trajectories/<节点执行 ID>.jsonl`。`run.trajectory` 按节点执行读取切片，超过 8 MiB 只返回大小，CLI 的 `ursi-flow run trajectory` 提供同一入口；`run.history` 携带运行时的定义快照，Flow 之后被改动或删除不影响已完成的运行。

### 通过平台执行 Agent 节点

给 daemon 设置 `URSI_EXECUTOR_PLATFORM_URL`（HTTP(S) origin，不含 `/api/v2`）和 `URSI_EXECUTOR_PLATFORM_TOKEN`（服务端 Bearer 令牌）。在 `run.start` 或 `run.startPinned` 的参数中加入 `"executorRef":{"id":"reviewer","revision":7}`，即可把本次运行中独立的 `新建Agent` 节点交给该修订。平台执行器须支持 `runConfig.nodeContract` 并生成 `flow-outcome.json`。平台使用自己的工作区，命令和子 Flow 仍由 daemon 调度。

节点可以声明自己的执行器：`新建Agent:名称` 的名称是平台执行器 id，可与结构化 JSON 组合（标记带执行器，JSON 带 profile/prompt）。启动 Run 时 daemon 按名称查询平台当前最新发布修订并钉进 Run，重试与恢复沿用同一修订；`复用Agent` 继承当前绑定的执行器，不能带后缀。本地 Pi 模式遇到执行器后缀会拒绝启动。

每次节点访问的 `attemptId` 可在 `run.history` 中查看。启动回执丢失后 daemon 查询原尝试；重启后状态为 `unknown` 时，用 `run.resume` 继续核实。已请求停止的运行应重试 `run.stop`。缺失结果文件或提交了该结果不允许的变量时，节点失败，历史里不会出现对应的路由判定。

## MCP 执行器 adapter

`ursi-flow-executor-mcp` 通过[执行器 SDK](../executor-sdk/README.md)为独立 MCP 客户端运行固定修订的整条 Flow。管理员为 adapter 设置以下环境变量：

- `URSI_EXECUTOR_ROOT`：每个尝试的受信根目录。
- `URSI_EXECUTOR_FLOW` 与 `URSI_EXECUTOR_FLOW_REVISION`：固定的 Flow 及目录修订。
- `URSI_FLOW_HOME`：运行 daemon 的私有目录，adapter 使用其中的 `runtime.sock`。

每个尝试的工作目录固定为 `<URSI_EXECUTOR_ROOT>/<attemptId>/workspace`，结果目录为其中的 `artifacts/`。`attemptId` 必须是小写标准 UUID，`workspaceRef` 和 `artifactDirectoryRef` 必须分别是 `workspace:<attemptId>` 与 `artifacts:<attemptId>`。adapter 会在调用 daemon 前检查目录所有权并拒绝符号链接，在检查和取消时还会验证 daemon job 身份。配置 revision 漂移或身份不匹配只返回冲突，不会影响其他 Run。

```sh
URSI_EXECUTOR_ROOT=/srv/ursi-executor \\
URSI_EXECUTOR_FLOW=material-review \\
URSI_EXECUTOR_FLOW_REVISION=revision-id \\
URSI_FLOW_HOME=/var/lib/ursi-flow \\
npx ursi-flow-executor-mcp
```

## 相关入口

- 推进引擎、日志实体与日志存储：[ursi-flow-runtime](../flow-runtime/README.md)。
- 执行器 MCP 协议：[docs/EXECUTOR-MCP.md](../docs/EXECUTOR-MCP.md)。
- Workbench Server 自动启动和关闭自己的 daemon，通过 `FlowClient` 与它通信。
