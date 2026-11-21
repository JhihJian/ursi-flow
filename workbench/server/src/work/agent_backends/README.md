# Agent 后端目录

每个 Agent 后端都接收相同的冻结快照，通过[执行器 stdio MCP 契约](../../../../../docs/EXECUTOR-MCP.md)处理工作指令和材料、输出报告。`capabilities` 仅列可选能力：`skills` 对应快照中的 Skill 正文，`tools` 对应管理员授权的工具引用。管理员在登记前审核能力，协议探测只核对执行器接口。

## 部署配置

- `URSI_PI_POLICY` 指向全局[模型和只读工具策略](../catalog/HTTP.md)。所有已配置后端共用该文件。
- `URSI_PI_EXECUTOR_BIN` 指向 Pi 执行程序。Pi 支持 `skills` 和 `tools`。省略此变量时，目录仍列出 `pi`，其 `configured` 为 `false`。
- `URSI_AGENT_BACKENDS` 可选，指向最多 2 MiB 的 UTF-8 JSON 数组文件。数组只登记额外的后端，例如：

```json
[
  {"id":"reporter","label":"报告生成","bin":"/opt/agents/reporter","capabilities":[]},
  {"id":"reviewer","label":"审阅助手","bin":"/opt/agents/reviewer","capabilities":["skills","tools"]}
]
```

两个配置文件都使用绝对路径，必须是服务账户或 root 持有的 `0600` 普通文件，文件本身不得是符号链接。`bin` 是可执行普通文件的绝对路径。ID 格式为 `[a-z0-9][a-z0-9._-]{0,63}`，在目录中唯一；`flow`、`pi` 为保留名。`label` 为 1 至 128 个 UTF-8 字节的显示名称，去除首尾空白且不含控制字符。每项必须提供 `capabilities`，空数组表示只提供基础能力。

启动时加载整个目录。后端配置缺少全局策略、路径或权限无效、清单格式错误都会使启动失败。更改注册信息后重启服务，检查状态随进程重置。试跑和发布前须重新检查，已绑定的版本与尝试可继续访问原后端。

## HTTP 接口

| 方法与路径（相对 `/api/v2`） | 结果 |
| --- | --- |
| `GET /agent-backends` | 返回描述数组。只读目录，不解析包，不探测后端。 |
| `GET /agent-backends?configPackageId=draft` | 只读解析该配置包，每项增加 `compatible`。快照中每个非空的 `skills`、`tools` 数组都需要对应能力。包解析错误按目录接口返回。 |
| `POST /agent-backends/{id}/check` | 通过 stdio 握手并列出工具，返回更新后的一项。未配置、协议探测或工作区准备失败时返回 HTTP 200、`status: "failed"`；未知 ID 返回 404。 |

未探测的目录项示例：

```json
{"id":"pi","label":"Pi","capabilities":["skills","tools"],"configured":false,"status":"unchecked","checkedAt":null}
```

`checkedAt` 是最近一次探测完成的 Unix 毫秒时间戳。`ready` 表示执行器接口通过检查，不表示已启动模型或调用业务工具。`compatible` 独立于配置与健康状态。程序路径、策略路径、工作区路径和协议错误细节均留在服务端。

## 工作模块接口

`Registry::from_env()` 在启动时构造注册表。`registry.routes(store)` 挂载目录和检查接口；克隆的注册表共享最近一次探测结果。

- `select(requested, snapshot)` 为新绑定选择已配置、`ready` 且兼容的后端。指定 ID 时只检查该项。省略 ID 时必须恰有一个候选，零个返回 503，多个返回 409 并要求指定 ID。
- `lookup(id)` 还原已发布或已登记尝试的部署绑定，只检查 ID 和启动配置。它可以在重启后尚未探测时使用，也不会改选其他后端。返回的 `Entry` 仅供服务端访问。
