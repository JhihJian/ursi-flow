# Agent Continuity

## 能力说明
支持 Agent Session 或 Thread 的复用、接管、恢复和身份校验。

## 依赖说明
依赖 `core/contracts` 的 Continuity 端口、Agent identity、Store facts 和 Runtime Tool schema。具体 Session 或 Thread 恢复由平台 Integration 提供。

## 启用与生命周期
复用 Agent、恢复中断 Run 或接管已有 Session 时启用。恢复前预检身份和工具 schema，Run 结束或失败时释放所有权。
