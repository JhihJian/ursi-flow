# ursi-flow-runtime

独立 Node 包，直接运行带固定 `FLOW.md` 入口的目录。需要 Node.js 22.19+；Agent 节点还需要可执行的 `pi` 和可用模型配置。本地模式会在当前用户权限下运行包中的命令，只运行信任的包。

从 `flow-runtime/` 安装可执行文件，然后可运行独立示例：

```sh
npm ci && npm run build && npm install -g .
ursi-flow-local check examples/ordinary
ursi-flow-local run examples/ordinary --variables '{"任务":"评审改动"}'
```

`--model provider/id` 选择 Pi 模型。`--cwd` 指定业务项目，`scripts/` 仍相对包根解析。默认历史文件是业务目录的 `.ursi-flow/history.json`，用 `--history` 可修改。测试真实 Pi CLI（已验证 1.5.2）运行 `TEST_REAL_PI=1 npm test`；模型响应由本地测试服务提供，不消费模型额度。`npm pack` 生成可独立安装的压缩包，安装后用 `ursi-flow-local check|run` 做单次执行。常驻管理服务 `ursi-flowd` 管理流程包、后台运行、配置和历史。[独立控制台](web/README.md) 是同一 daemon 的浏览器入口，构建产物可单独发布或嵌入工作台。[Rust Server](../workbench/server/README.md) 自动启动和关闭自己的 daemon，通过 `FlowClient` 与它通信。仅使用 [独立 CLI](client/README.md) 时可自行启动 daemon。

## 以服务方式运行

作为 systemd 用户服务或容器入口运行 daemon 时，Agent 节点仍然按进程环境调用 `pi`，因此有两件事必须显式提供，否则节点会在第一次执行时失败：

- **可执行文件**：服务 `PATH` 要能找到 `pi`，或用 `URSI_FLOW_PI` 指定完整路径。nvm 之类的安装目录通常不在系统默认 `PATH` 里。
- **模型凭据**：适配器按 `--no-extensions` 启动 Pi，用户的 Pi 扩展不参与，模型凭据只能来自环境变量（例如 `DEEPSEEK_API_KEY`）或 Pi 自己的 `auth.json`。凭据放在 `0600` 的环境文件里由服务加载，不要写进单元文件。

```ini
Environment=PATH=/home/me/.nvm/versions/node/v24/bin:/usr/local/bin:/usr/bin:/bin
EnvironmentFile=%h/.config/ursi-flow/daemon.env
```

模型可以用 `ursi-flowd` 的配置固定（`~/.ursi-flow/config.json` 的 `model`，控制台“运行配置”里也能改），避免依赖 Pi 的默认模型解析。节点失败时错误摘要会带上 Pi 的 `stderr` 尾部，例如模型缺少凭据会直接显示原因。

## 项目边界

- `src/core/definition`、`execution`、`state`、`contracts`：包发现与解析、结果边路由、运行记录、调用契约。SDK 使用 `ursi-flow-runtime/core`。
- `src/ability`：Agent 的创建与复用、每次节点执行独立的结果提交工具和能力协议。解析器、Core、Ability 与 [Flow 规范](docs/flow-spec.md) 引自 MIT 授权的 Agent-Flow-Runtime `e4ea1ee52c91a039676f8673baf939f83dad9146`。定义以源码和参考 fixtures 验收。
- `src/executor-adapters/local-pi`：按节点启动 `pi --mode json`。新 Agent 使用独立的会话 ID，复用节点用同一 ID 重新打开会话。只有显式的 `submit_flow_outcome` 工具回执参与路由。命令、文件历史、并行及子 Run 装配也由本地主机提供。本版 Pi 适配器只启用结果工具，声明业务工具、Skill、Profile 或要求接管既有会话会被拒绝。
- `src/integrations/mcp`：[集成边界说明](src/integrations/mcp/README.md)。MCP 和 Gateway 执行器尚未提供。
