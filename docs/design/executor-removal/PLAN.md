# 移除执行器线与 Workbench

## 结论

2026-11-26 删除 `executor-platform`、`executor-sdk`、`planweave-demo` 和 `workbench` 四个目录。执行能力不迁移，相关界面与文档一并移除，`apps/mcp-web` 的识别规则只保留通用机制。

处理依据：

- `executor-platform` 的 Flow 宿主和 pi-executor 已在更早的提交中删除，剩余消费者只有 Workbench。
- Workbench 的工作项、项目规划、工作包、生成器和 MCP 服务登记没有替代模块，本次一并接受能力下线。
- `executor-sdk` 与 `planweave-demo` 没有代码消费者。
- Agent 执行由 Pi 管理台的一次性会话和 Pi 交互对话承担。

## 删除与保留

| 对象 | 处理 |
| --- | --- |
| `executor-platform/` | 整体删除，包含 server、web、acceptance、migration、lockfile 与构建产物 |
| `executor-sdk/` | 整体删除 |
| `planweave-demo/` | 整体删除 |
| `workbench/` | 整体删除，包含 Rust Server、React Web、验收夹具、Cargo 与 npm 锁文件 |
| `docs/design/workbench/`、`docs/design/executor-platform/`、`docs/EXECUTOR-MCP.md`、`docs/design/todo-web/EXECUTION-AND-EMBEDDING.md` | 删除 |
| `apps/mcp-web` 识别规则 | 保留规则引擎，默认规则改为空，去掉 `executorProtocol` 种子与执行器措辞 |
| `docs/design/mcp-web/RECOGNITION-RULES.md` | 由执行器协议发现设计改写为通用识别规则设计 |

Workbench 删除后，`ursi-executor-platform` 不再有代码消费者，因此不需要把 `Store`、`directories`、`Error` 内联到任何模块。

## 文档与规格

根 `SPEC.md`、`ARCHITECHTURE.md` 移除 Workbench、执行器平台、执行器 SDK 的模块行、模块关系、设计索引行与相关入口，并删除「从工作清单生成文件包」验收。`apps/todo-web/SPEC.md` 去掉已删除的嵌入设计引用，`apps/ursi-sandbox` 去掉指向 Workbench 的链接与措辞，`docs/design/flow-runtime/RUNTIME.md` 去掉 Workbench 测试命令。

## 运维收尾

执行前先归档，归档目录为 `~/.local/state/ursi-removal-backup-20261126/`，权限 0700，包含：

- `executor-platform-lan.tar.gz`
- `work-projects-preview-20261123.tar.gz`
- `work-projects-planweave-20261124.tar.gz`
- `workbench-data.tar.gz`
- `ursi-workbench-config.tar.gz`
- `SHA256SUMS`

停止并清理以下 transient 用户单元：`ursi-executor-platform-lan-api`、`ursi-executor-platform-lan-web`、`ursi-mcp-preview-api`、`ursi-mcp-preview-peer`、`ursi-mcp-preview-web`、`ursi-planweave-preview-api`、`ursi-planweave-preview-easytier`、`ursi-planweave-preview-web`、`ursi-work-projects-api`、`ursi-work-projects-lan-web`、`ursi-work-projects-web`。同时停止残留的 Workbench 验收进程。

归档后删除状态目录：`~/.local/state/ursi-executor-platform-lan`、`ursi-work-projects-preview-20261123`、`ursi-work-projects-planweave-20261124` 和 `~/.config/ursi-workbench`。`18202`、`4175`、`4281`、`4284`、`4285`、`5187` 均已释放。`8080` 与 `8081` 属于无关的 docker-proxy，不动。

`ursi-mcpd`、`ursi-mcp-https` 和其他与本次无关的服务保持运行。`ursi-flow-console` 当时保留，后在 2026-11-27 随 `flow-runtime/web` 死单元一并下线。

## 验证

- 全仓搜索 `executor-platform`、`executor-sdk`、`planweave-demo`、`docs/design/workbench`、`workbench/`，除本文件与构建缓存外无命中。
- `apps/mcp-web/server` 的 `cargo test` 通过，`apps/mcp-web/app` 编译通过。
- `apps/mcp-web/web` 的 `npm test` 与 `npm run typecheck` 通过。
- 根 `package.json` 的 workspaces 不包含被删目录，无需调整锁文件。

## 回滚

四个目录的代码在 Git 历史中保留，可按删除提交反向恢复。运维数据从归档目录解包回原路径，再重新创建用户单元。归档 `SHA256SUMS` 可用于校验完整性。
