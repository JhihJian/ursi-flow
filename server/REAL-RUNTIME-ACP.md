# 从 Flow 调用 Runtime ACP

Server 按运行选择已就绪的沙箱，经内部 `/acp` WebSocket 执行 `pi` 文本节点。Gateway key 用于查询和管理资源，Runtime token 用于该沙箱的会话鉴权。生产进程不使用独立 CLI 的全局端点或 token。

## 从全局 Runtime 迁移

1. **清理服务环境。** 从启动脚本、服务配置和继承的环境中移除 `URSI_ACP_URL`、`URSI_SESSION_TOKEN`、`URSI_SESSION_TOKEN_FILE`、`URSI_CLIENT_TIMEOUT_SECS`。任一变量仍存在（即使为空），Server 会在打开存储前报迁移错误。独立 CLI 可在自己的进程环境中继续使用这些变量。
2. **配置接入。** 在默认 feature 构建中成对设置 `URSI_GATEWAY_URL`、`URSI_GATEWAY_KEY`，并设置 `URSI_ACP_BINDINGS_DIR` 为管理员维护的私有绝对目录。启动方式见 [Server README](README.md)。
3. **迁移角色。** 旧角色可以查询。通过角色 API 显式修改为 `executorKind: "pi"`，或创建新角色并更新流程引用。将 `model: "runtime-profile"` 替换为 Runtime profile 中的实际模型名，保留有效的 `connectionId`。使用单文件文本 `SKILL.md` 并令 `mcpServers` 为空。旧执行器写入或引用旧角色创建运行均返回 HTTP 409。
4. **新建运行，再绑定资源。** 创建运行以冻结新角色，为该 run 申请沙箱并核对 Gateway 的就绪状态、沙箱 ID 及唯一的内部 `session` 端点。准备工作目录 `/ursi/workspace/repo` 和 Pi 模型配置，原子安装 `<run_id>.json` 后再启动运行。文件格式、权限和准入失败语义见 [ACP 绑定说明](../sandbox-access/ACP.md)。

旧快照保留原身份。即使同名角色已更新为 `pi`，启动冻结为 `runtime-acp` 的旧运行仍返回 409，不占新 attempt。未开始的旧运行可以取消；已发送 prompt 且回执未知的旧 attempt 保留原状，先核实原沙箱再决定如何处置。不要通过改写快照、沿用全局 token 或自动重发来迁移在途任务。

## 取消与断连

当前 Runner 在提交 prompt 的同一连接上向同一会话发送 `session/cancel`。取消通知只表达意图，原 prompt 的停止原因和 `_ursi/session/close` 回执共同确认收尾。断线、超时、停止响应或回收结果未知时，节点保留当前 attempt；重新启动或接管租约不会重投这轮 prompt。

## 验收差异

| 入口 | 验证对象与边界 |
| --- | --- |
| [历史联合验收记录](../ursi-sandbox/INTEGRATION-ACCEPTANCE.md) | Flow 源码 `e7a100f` 的全局 Runner 和独立 CLI 连接正式 session-service，使用真实 Pi 与固定响应的模型替身，验证文本及正常关闭。记录仅适用于该提交和所列制品，不覆盖当前 HTTP 工作流和逐运行绑定。 |
| `cargo test --locked -p ursi-server --test acp_migration --test remote_execution` | 本地测试验证旧配置与旧快照的拒绝路径，以及当前 HTTP、SQLite、Gateway/ACP 协议对端下的执行、取消和结果未知处理。对端不运行 Pi 或模型。 |
| `server/tests/scripts/verify_runtime_acp.sh <独立构建目录>` | **当前版本的待核验入口**。需本机 Linux Docker bridge、脚本指定的 Runtime 镜像、匹配的独立 CLI 和 dist bundle。测试通过 Server HTTP 创建角色和运行、安装运行绑定并调用正式 Runtime，检查固定输出、关闭及清理；Gateway 视图和模型端点均为替身。脚本中的全局变量供测试夹具和 CLI 使用，Server 子进程单独配置。 |

当前版本的真实 Runtime 结果需以本次构建的提交、镜像和 bundle 摘要及脚本输出为据。真实 Gateway 生命周期、SSH/SFTP、远端文件产物和真实模型推理需要各自的联合验收。
