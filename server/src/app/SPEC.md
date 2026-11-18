---
parent: ../../SPEC.md
depends-on:
  - ../storage/SPEC.md
  - ../connections/SPEC.md
  - ../roles/SPEC.md
  - ../workflows/SPEC.md
  - ../artifacts/SPEC.md
  - ../sandboxes/SPEC.md
  - ../runs/SPEC.md
  - ../transport/SPEC.md
  - ../../crates/channel/SPEC.md
  - ../../crates/agent-runtime/SPEC.md
references:
  - ../../DESIGN.md
---

# app

## 功能意图

作为主服务的组装根，读取配置、创建各模块实现、启动后台任务和协议服务，并协调关闭。二进制入口只调用本模块。真实 CLI Adapter 由沙箱 session-service 装配，主服务装配 Channel 和 Agent Runtime 客户端。

## 关键功能与验收

### 配置与依赖装配

解析服务监听、存储位置、Gateway 连接和运行参数，按依赖顺序构造存储、业务服务、执行客户端和传输入口。默认网络监听地址为 0.0.0.0。真实 Runtime ACP 是显式 opt-in：`URSI_ACP_URL` 必须和 `URSI_SESSION_TOKEN` 或 `URSI_SESSION_TOKEN_FILE` 成对设置，可选 `URSI_CLIENT_TIMEOUT_SECS`；该配置只提供真实 Runner，不改变普通角色的默认执行器。

#### 验收

- 给定有效配置，装配记录显示共享事务设施和对应服务实例正确注入。
- 缺失必需配置、非法地址或无法打开存储时，启动失败并返回明确原因，不报告服务就绪。
- 测试可以注入组件工厂或接口替身，运行生命周期测试无需 Docker 或模型服务。
- ACP 只设置一侧、同时设置 token 环境变量与文件、或 timeout 越界时，装配在打开存储前明确拒绝。
- 仅冻结的 `executorKind: "runtime-acp"` 选择真实 Runner。未配置时该节点明确失败，其他执行器类型和未指定类型仍走 MockRunner。
- ACP 使用环境配置的 Runtime 会话地址和令牌；角色的模型连接仍须通过校验，但不用于配置或认证该会话。
- 配置诊断与启动日志不打印凭据明文。

### 启动与后台任务

完成迁移后启动运行恢复、资源核实等后台任务及传输入口。就绪状态反映必要依赖是否已成功初始化。

#### 验收

- 存储初始化成功后才启动消费该存储的业务服务与后台任务。
- 中途组件启动失败时，已启动组件被关闭，监听与后台任务不残留。
- 真实 SQLite 与 HTTP 组装后，可经接口保存配置、创建运行并查询状态。
- 服务重启后，已持久化配置可读回，未完成运行由 runs 的恢复规则处理。

### 有序关闭

收到终止信号后停止接收新业务操作，通知运行服务停止调度并按其执行状态规则处理活动任务，关闭事件订阅和连接，最后释放存储。

#### 验收

- 生命周期替身记录的关闭顺序满足业务组件先于其存储依赖关闭。
- 关闭期间不创建新运行，状态提交完成前不关闭数据库。
- 超时或执行结果未知时记录可恢复状态，不伪造任务或资源已成功结束。
- 重复关闭请求具有幂等结果，监听端口和后台句柄最终释放。

## 交付与验收边界

独立验收使用配置夹具、可记录启动关闭的组件和故障注入，验证装配、就绪、回滚与关闭顺序。当前真实接入已到 Runtime ACP WebSocket 与 Flow Runner 层，可用 `server/tests/real_runtime_acp.rs` 在显式 opt-in 下核验；尚未声称 Gateway 准备、沙箱 SSH/SFTP、真实模型和产物回收组成的整链完成。完整 app 联合验收仍需真实 Gateway、Channel、Agent Runtime、沙箱和 artifacts 证据。

app 不承载角色、流程或节点业务规则。各模块行为以自身 SPEC 为准，主服务集成测试负责证明组合后的配置和调用关系正确。
