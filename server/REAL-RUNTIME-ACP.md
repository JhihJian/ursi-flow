# 从 Flow 调用 Runtime ACP

Flow 使用 `ursi-sandbox-client` 的公开 Rust API 连接已运行的 Runtime `/acp` WebSocket。Gateway 创建沙箱、安装 bundle、配置模型以及通过 SSH/SFTP 准备 `/ursi/workspace/repo` 都是调用前提。地址和令牌由 Flow 管理员提供，不从角色或流程参数读取。一个 Flow 实例的 ACP 节点共享同一 Runtime 和工作目录，只应运行同一信任主体的任务。

## 启用执行器

在 Flow 仓库根目录运行，替换为实际端点和令牌文件：

```bash
export CARGO_TARGET_DIR=/data/dev/ursi-flow/target
export URSI_ACP_URL=ws://127.0.0.1:8765/acp
export URSI_SESSION_TOKEN_FILE=/private/session-token
export URSI_CLIENT_TIMEOUT_SECS=120
cargo run --locked -p ursi-server --bin ursi-flow
```

远程端点请使用 `wss://` 或受保护的隧道。`URSI_SESSION_TOKEN` 和 `URSI_SESSION_TOKEN_FILE` 二选一，URL、令牌必须成对设置。每次请求的超时可选，默认 120 秒，范围 `1..=86400`。配置非法时应用在打开存储前报错。配置合法不代表已连通，首次创建 ACP 会话时才连接。

通过 `POST /api/v1/roles` 创建角色。将示例中的 `connectionId` 替换为 Flow 中已有的有效连接标识：

```json
{
  "id": "runtime-writer", "name": "Runtime 写作节点", "prompt": "请用中文简短回答。",
  "executorKind": "runtime-acp", "model": "runtime-profile",
  "connectionId": "existing-connection-id", "skills": [], "mcpServers": []
}
```

让工作流的 agent 节点引用该角色后创建并启动运行。只有冻结时选择了 `runtime-acp` 的角色会使用该端点；端点未配置时该节点明确失败。普通角色与旧快照仍按原有 mock 路径执行。`runtime-profile` 表示接受 Runtime 管理员固定的模型；Flow 仍校验角色的连接引用，但不向 Runtime 下发该连接的端点或凭据。模型覆盖、Flow Skills 与非空 MCP 列表均不受支持。

## 单独验证已有真实服务

在同样的 ACP 环境配置下，从仓库根目录执行（无需启动 Flow HTTP 服务）：

```bash
URSI_FLOW_REAL_ACP=1 CARGO_TARGET_DIR=/data/dev/ursi-flow/target \
  cargo test --locked -p ursi-server --test real_runtime_acp -- --ignored --nocapture
```

该测试会创建真实会话并提交一轮 prompt，可能产生模型费用。它要求收到文本、`end_turn` 以及关闭确认。断线或响应无效时不能推断任务已结束，引擎不自动重放结果未知的 prompt。

## 验证边界

- 本地 WebSocket 对端测试覆盖初始化、建会话、文本和工具通知映射、取消、状态查询与关闭；HTTP 和 SQLite 测试用 Runner 替身验证角色保存、运行快照和重启后的分派。
- 上述 opt-in 命令单独验证 Flow Runner 到正式 Runtime 的连接。它不验证 HTTP 工作流端到端、Gateway 生命周期、工作区准备、产物回收或多租户隔离。Flow 的运行取消仍遵循现有引擎语义，不等同于控制器的在途 `session/cancel` 通知。
