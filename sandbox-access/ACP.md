# 生产文本任务的 ACP 接入

Server 直连 Runtime 的 `session` 内部端点。此模式适用于受控的私有网络或回环地址：`ws://` 不加密，请勿通过不受信任的网络传输身份或任务。Gateway 密钥仅用于资源控制。

1. 在 Server 启动环境设置 `URSI_GATEWAY_URL`、`URSI_GATEWAY_KEY` 和 `URSI_ACP_BINDINGS_DIR`。最后一项是管理员维护的绝对目录，位于工作区、数据上传目录和静态资源根目录之外。目录及祖先仅允许可信用户写入。
2. 创建 run，准备该运行的沙箱。管理员核实沙箱 ID、镜像、Runtime profile 和内部 `session` 地址；准备好 `/ursi/workspace/repo` 与 Pi 模型配置。对每个沙箱使用独立的 Runtime token。
3. 在身份目录中原子安装 `<run_id>.json`，仅 Server 账户可读（例如 `0400`）。以下为字段示例，`token` 由该沙箱的 `session-token` 提供，`model` 对应 profile 的 `session.json`。身份和地址都不由入站 API 接收。

```json
{"sandbox_id":"sb-example","address":"172.18.0.9:8765","token":"<该沙箱至少32字符的专用身份>","model":"<Runtime 模型名>"}
```

启动运行时和执行文本节点前，Server 都会重新查询 Gateway 并核实关联。只接受唯一的 `internal` `session` 端点，其地址必须是私网或回环 IP，且 IP、端口和沙箱标识都与身份文件匹配。缺少身份文件或端点不匹配时，准入返回 503。运行结束后由管理员撤下对应身份文件。

角色须显式选择 `executorKind: "pi"` 及相同模型。单文件 `SKILL.md` 以文本指令随角色提示词、运行输入和节点上下文发出。多文件技能、MCP、脚本和文件产物不在此路径中。模型提供方的实际凭据由 Runtime profile 管理。

每次执行使用新会话。`cancel` 在同一连接上定位该会话。服务以原 prompt 的停止响应和会话关闭回执确认终态。控制调用限时 15 秒，prompt 限时 10 分钟，单条消息与聚合文本上限各 1 MiB。断连、超时、无效停止响应或回收结果未知时保留当前 attempt，后续 start 和租约接管均不重发。此时由操作方核实远端状态或释放原沙箱。

`sandbox-access` 使用 `ursi-sandbox-client` 的 `PromptOutcome` 解析停止原因，使用 `Secret` 在拼接文本后脱敏。`Binding::session_status` 使用 SDK 的 `Acp` 在独立鉴权连接上读取状态；该快照不会替代原 prompt 或关闭回执。SDK 的 `Acp::request` 等待响应期间独占连接，因此在途 prompt 与取消通知由同一个有序 WebSocket 传输。

真实服务核验：`server/tests/scripts/verify_runtime_acp.sh <独立构建目录>` 使用受控 Gateway 视图、生产 Runner 和真实 Runtime，检查本地模型替身的固定输出、会话关闭及清理。普通测试不会连接真实服务。

独立协议测试：`cargo test -p ursi-server --test remote_execution`。使用生产装配、SQLite 和实际 HTTP/WebSocket 连接；测试中的协议对端不调用模型。

从全局 `runtime-acp` 角色升级时，先清除 Server 的旧环境变量，迁移角色后创建新运行。旧快照保留原身份。操作顺序、HTTP 冲突语义及历史证据适用范围见 [迁移与验收差异](../server/REAL-RUNTIME-ACP.md)。
