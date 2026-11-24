# Agent 后端部署与检查

在执行器平台进程中登记受管 Agent。平台与每个后端使用同一套 [ACP v2 stdio 执行契约](../../../../../docs/design/executor-platform/ACP-PROFILE.md)。Pi 是内置目录项；额外后端也须实现相同的协议及本机作业、终态和文件交付约定。

## 部署配置

| 环境变量 | 用途 |
| --- | --- |
| `URSI_PI_POLICY` | 所有已配置后端共用的模型和只读业务工具策略文件。见 [Pi 策略格式及示例](../../../../../flow-runtime/src/pi-executor/README.md#部署策略)。 |
| `URSI_PI_EXECUTOR_BIN` | `ursi-pi-executor-acp` 的绝对可执行路径，或管理员维护的等效启动器。省略时目录仍显示 `pi`，`configured` 为 `false`。 |
| `URSI_AGENT_BACKENDS` | 可选。额外受管后端的 UTF-8 JSON 清单，最多 2 MiB。 |

使用 Node.js 22.19 或更高版本，按 [Flow Runtime 构建说明](../../../../../flow-runtime/README.md)先构建 Flow Core，再构建并打包 Runtime。后端与平台在同一 Linux 主机和文件系统上运行。平台清空继承环境，仅提供固定 `PATH`、`URSI_EXECUTOR_ROOT`、`URSI_PI_POLICY`，以及正式尝试的 `URSI_ACP_JOB`。若 Node 不在 `/usr/local/bin:/usr/bin:/bin`，用受管启动器按绝对路径启动 Node 和 `dist/pi-executor/acp.js`。标准输出留给 UTF-8 JSON-RPC 消息，每行一条；平台不转发子进程 stderr。生产中固定程序与依赖版本，并限制部署路径的写权限。迁移时将原 MCP 程序路径改为 ACP 程序路径，并重新发布执行器修订。

`URSI_PI_POLICY` 和清单文件都须使用绝对路径，为服务账户或 root 持有的 `0600` 普通文件，文件本身不得是符号链接。`bin` 须是指向可执行普通文件的绝对路径。每个后端需声明 `capabilities`，可选能力为 `skills`、`tools`、`flowOutcome`，可用空数组表示仅支持基础执行。Pi 声明三项能力。额外清单示例：

```json
[
  {"id":"reporter","label":"报告生成","bin":"/opt/agents/reporter-acp","capabilities":[]},
  {"id":"reviewer","label":"节点审阅","bin":"/opt/agents/reviewer-acp","capabilities":["skills","tools","flowOutcome"]}
]
```

ID 格式为 `[a-z0-9][a-z0-9._-]{0,63}`，须唯一；`flow` 和 `pi` 为保留名。`label` 须为 1 至 128 个 UTF-8 字节，首尾无空白且不含控制字符。缺少策略或显式配置无效时，平台拒绝启动。更改注册信息后重启平台并重新检查；程序或策略路径改变后，用新绑定重新发布执行器修订。

## HTTP 接口

路径相对于平台 `/api/v2`，使用平台管理员令牌。

| 方法与路径 | 结果 |
| --- | --- |
| `GET /agent-backends` | 列出配置状态、能力声明和最近一次检查结果。 |
| `GET /agent-backends?configPackageId={id}` | 解析指定配置包，每项另返回 `compatible`。非空的 Skill 或工具列表分别要求 `skills` 或 `tools`。 |
| `POST /agent-backends/{id}/check` | 在临时工作区执行 `initialize`、`session/new` 和 `session/close`，确认进程回收。成功为 `ready`；未配置、协商或清理失败为 `failed`，均返回 HTTP 200。未知 ID 返回 404。 |

`checkedAt` 是最近一次检查完成的 Unix 毫秒时间戳。启动时状态为 `unchecked`，时间为 `null`。预检使用临时会话，不提交任务、不调用模型或业务工具；正式执行时才装配该修订的配置快照。后端路径、策略正文和协议错误详情不通过目录接口公开。

新发布与草稿试跑要求后端已配置、`ready` 且与配置包兼容。指定 `backendId` 时只检查该项，省略时必须恰有一个候选。已有 ACP 修订仍按原绑定执行，不受最近一次预检状态影响。用于 Flow 节点时，后端还须声明 `flowOutcome` 并支持 `runConfig.nodeContract` 和对应结果制品。
