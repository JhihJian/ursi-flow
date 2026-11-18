# Server 与沙箱的构建及协议边界

`ursi-flow` 是一个 Server 进程。平台工作区有三个包：`flow-core` 定义业务和端口，`sandbox-access` 实现远端接入，`server` 选择实现并提供 HTTP、SSE 和 MCP。Gateway、Runtime 和独立 CLI 仍由 `ursi-sandbox` 工作区构建。两边通过版本化协议交互，沙箱不导入 Flow 类型。

## 唯一的跨工作区 Rust 依赖

只有 `sandbox-access` 可直接依赖公共 SDK `ursi-sandbox-client`。ACP 复用 SDK 的停止原因解析、凭据脱敏和独立状态查询。生产 Runner 的 prompt 和取消需要同一条有序连接，因此该收发循环由接入层负责。SDK 不替代 Gateway v1 消费方适配，也不把 Gateway 或 Runtime 的内部 DTO 引入业务域。

| 平台包 | 允许的本地依赖 | 职责 |
| --- | --- | --- |
| `flow-core` | 无 | 领域契约、六个业务域、存储、Runner 与资源端口。测试可注入执行器。 |
| `sandbox-access` | `flow-core`、公共 SDK | `gateway_v1` 转换资源协议，`channel` 提供连接和文件传输，`runtime_acp` 处理逐运行绑定及文本执行。`session` 是独立的帧级控制器。 |
| `server` | `flow-core`、可选 `sandbox-access` | app 装配、transport、`src/mcp` 工具域；不带默认 feature 的构建不链接接入库或 SDK。 |

旧 `server/crates` 的 domain 和执行端口归入 core，Channel 与会话协议归入接入层，MCP 工具归入 Server。远端 CLI 生命周期归 Runtime，平台构建不需要 CLI Adapter 或观测实现的源码。

## 离线操作与远端准入

配置、创建运行与冻结快照、纯审批、记录取消意图、查询历史与已归档产物均可使用本地存储。平台保存的沙箱关联表示上次观测；执行前要向 Gateway 实时核实资源。

Gateway 独占资源生命周期。平台经 [Gateway v1 契约](../contracts/gateway/v1/README.md) 申请、观察和释放资源。`gateway_v1` 持有地址、Bearer key、HTTP 客户端及 wire DTO，向业务域只返回平台状态和错误。HTTP、MCP 和运行收尾使用同一关联与释放服务。

| 协议结果 | 平台行为 |
| --- | --- |
| 创建请求待确认 | 复用已保存的操作 ID（`Idempotency-Key`）和冻结规格；超时、重启不分配新身份。 |
| 创建 `202` 并带资源 ID | 只记录已受理。实时查到 `running` 且无待处理操作，才视为资源就绪。 |
| 删除 `202` | 状态为释放中。已知资源在删除确认流程中返回 `404` 才记已释放，普通查询 `404` 表示资源不存在。 |
| 响应丢失、状态未知或响应不合法 | 保留关联待核实；将鉴权失败、幂等冲突、协议错误与网络故障分开。 |

当前生产路径只准入具有运行专属绑定的 Pi 文本节点。Server 直连 Gateway 报告的内部 `session` 端点。申请沙箱成功不等于会话已绑定，发送取消意图也不等于任务已停止。脚本和文件产物通道尚未装配；这类工作流启动时返回 `503 sandbox_unavailable`。旧角色与冻结运行的处理见 [ACP 迁移说明](REAL-RUNTIME-ACP.md)。

## 验收分界

- **业务与协议测试**：core 使用临时存储及端口替身。Server 通过 HTTP 对端验证 Gateway 请求、鉴权、幂等键、受理与确认，通过 ACP WebSocket 对端验证文本与取消。脚本及产物归档使用可注入的测试工作区。
- **隔离构建**：`scripts/ci/run-workspace-isolation.sh server` 复制三个平台包、公共 SDK 源码与必要清单、独立的 v1 制品。检查依赖方向，并构建和测试默认接入能力及无接入的 Server。Gateway、Runtime 及模型服务均无需在场。
- **真实服务联验**：Server HTTP 到正式 Runtime 的复验方法、所用替身及历史版本差异见 [Runtime ACP 验收说明](REAL-RUNTIME-ACP.md#验收差异)。资源创建与回收、远端文件传输、真实模型推理各自需要相应服务及证据。
