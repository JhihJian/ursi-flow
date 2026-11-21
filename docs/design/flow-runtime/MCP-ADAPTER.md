# MCP 集成边界

`ursi-flow-executor-mcp` 是 Flow Runtime 的本机 MCP stdio adapter。它通过独立的[执行器 SDK](../../../executor-sdk/README.md)提供 MCP 发现和三个执行器工具：

- `executor_start`：以 `attemptId` 作为 daemon Run ID，调用 `run.startPinned`。
- `executor_inspect`：调用 `run.get`，只返回该管理员绑定 Flow 的状态。
- `executor_cancel`：核对绑定和工作目录后调用 `run.stop`。

工具成功结果同时放在 `structuredContent` 和单个 JSON text 中。工具失败不会泄露路径、配置或 daemon 错误，text 只含 `invalid`、`conflict`、`not_found`、`busy` 或 `unavailable` 之一。

启动 adapter 需要管理员提供 `URSI_EXECUTOR_ROOT`、`URSI_EXECUTOR_FLOW`、`URSI_EXECUTOR_FLOW_REVISION` 和 `URSI_FLOW_HOME`。Workbench 为每个尝试准备 `<URSI_EXECUTOR_ROOT>/<attemptId>/workspace`，Flow 在其中使用 `artifacts/` 写结果。adapter 在启动、检查和取消前检查目录为真实目录且由当前用户拥有，并核对保存的 daemon job 的 Run ID、Flow、revision、cwd 和任务变量，避免配置漂移或误停其他运行。

适配器复用 daemon 的状态机和 `run.startPinned/get/stop`，不公开节点内部的 `submit_flow_outcome`，也不创建第二套运行记录。
