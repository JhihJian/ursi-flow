# 固定执行器修订的跨进程验收

从仓库根目录运行 `./executor-platform/acceptance/run.sh`。需要 Linux、Rust 1.88+、Python 3 和 Node.js 22.19+，以及按 [Runtime 构建说明](../../flow-runtime/README.md)构建的 Flow Core 和安装完成的 `flow-runtime/node_modules`。脚本从当前源码构建平台、Workbench 服务端与 Flow daemon。构建缓存位于 `.build/`，每次测试新建独立数据目录并在结束时清理。

验收用真实平台、Workbench 和 Flow daemon 覆盖固定修订与执行生命周期。平台连接可控的 stdio ACP v2 测试后端。用例通过 HTTP API 发布 `reviewer@1` 与系统提示词不同的 `reviewer@2`，并固定使用旧修订执行。

- `test_direct`：通过 Workbench 执行工作包，读回输入标记、旧提示词和原尝试 ID。修改工作包后以同 ID 重试仍使用原快照，换用另一个工作包返回 409。
- `test_flow`：通过 Workbench 启动审核流程，核对“退回”结果、回执变量、选边、后续节点和制品。`test_invalid_flow_artifact_is_not_published` 通过 Runtime 角色直接提交节点任务，核对平台拒绝发布契约未声明的结果。
- `test_delayed_ack_and_early_updates`：建会话回执前的根会话更新按序入账，其他会话的更新被忽略。后端发送插入回显和实时结束通知后，用反向权限请求同步，再发插入 ACK。
- `test_lost_ack`：缺 ACK 时，有对应的用户消息回显与可信终态可成功。缺 ACK 和回显时，即使后端写出了文件并发出了结束通知，仍返回 `unverified`，不发布制品。
- `test_stale_idle`：用文件信号控制后端恢复时机，确认前台运行之前的 `idle` 不改变尝试状态。根会话运行中收到其他会话的 `idle` 也不会提前结束。
- `test_restart_and_cancel`：读到运行状态和工具更新后重启平台，用相同 ID 查询与重复提交仍指向原尝试。从原游标读回取消事件，并核对后端只收到一次任务提交、一次取消。
- `test_events_wait_does_not_block_cancel`：已有记录立即返回，空页按 `waitMs` 等待；并行等待可被新帧或 worker 停止唤醒，且不阻塞同一尝试的取消。
- `RpcFailureIntegration.test_rpc_error_stays_private`：建会话返回带私有内容的错误，核对事件只留下 RPC 方法和阶段。延迟回执用例另核对会话 ID、幂等键和消息回执 ID 均不进入轨迹。
- `test_worker_crash_is_unverified`：强制停止 worker，核对受管 Agent 停止、轨迹记录一次缺口，且原尝试不重放、不发布制品。

轨迹通过平台 `GET /api/v2/executor-attempts/{id}/events?after=0` 查询，响应包含带递增 `seq` 的 `events` 和数值 `nextCursor`。验收检查按游标续读、系统提示词未进入轨迹、未认证返回 401，以及非归属角色（含管理员）返回 404。Workbench、Runtime 与浏览器各用独立令牌。`URSI_FLOWD_BIN` 指向私有启动脚本，由 Workbench 启动真实 daemon 并传入 Runtime 令牌。
