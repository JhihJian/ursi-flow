---
parent: ../SPEC.md
references:
  - ../server/HTTP.md
---

# 待办实体与状态机

## 功能意图

`todo-core` 是待办库读写双方共享的唯一实体来源。看板服务端直接使用这里定义的 `Task`、`Project`、`Status`、`Priority`、`Creator` 和状态机，不再维护自己的字段表与迁移规则。crate 只提供类型、状态迁移、ID 生成和错误码，不打开数据库、不建表、不决定存储布局。

## 关键功能与验收

### 实体定义

#### 验收

- `Task` 包含 id、title、content、project_id、creator、created_at、priority、tags、parent_id、pre_id、due、status、assignee、blocked_reason、result、artifacts、log、started_at、finished_at、updated_at，`Project` 包含 id、name、description、path、created_at、updated_at。
- `log` 保存工作过程的记录，`result` 保存工作结果，两者都是可选的 Markdown 文本；两者不绑定完成动作，跨状态迁移保留。
- `Task::append_result` 去掉首尾空白后把新内容以空行分隔追加到已有 `result` 之后，空文本返回 `InvalidInput`。
- 序列化字段名与库列同名，可选字段为空时省略键，因此同一份 JSON 既能被 CLI 输出，也能被看板直接返回给前端。
- 新建任务默认 `pending`、`medium` 优先级、`human` 创建者，标签与产出物为空。

### 状态机

#### 验收

- 允许的迁移为 `pending → in_progress|cancelled`、`in_progress → done|blocked|cancelled|pending`、`blocked → in_progress|cancelled`、`done → in_progress`，其余迁移返回 `InvalidTransition`。
- 进入 `in_progress` 写 `started_at` 并记录执行者；完成写 `finished_at` 并保存结果与产出物，未提交日志时不覆盖已有过程记录；阻塞保存原因，恢复时清空原因；取消写 `finished_at`。
- 完成必须提交结果，阻塞必须提交原因，缺失时分别返回 `ResultRequired` 与 `BlockedReasonRequired`。
- 目标状态与当前状态相同时是幂等空操作，不改写时间字段；`cancelled` 为终态，拒绝任何后续迁移。撤销完成时只清空结果、产出物与完成时间，过程记录保留。

### 错误码

#### 验收

- 每个错误携带稳定的 `code()`（如 `E_INVALID_TRANSITION`、`E_RESULT_REQUIRED`、`E_TASK_NOT_FOUND`）与 `exit_code()`，CLI 和 HTTP 服务共用同一套标识。

### ID 生成

#### 验收

- `generate_id` 从 UUID v7 取 8 位十六进制，长度固定，并在写入前检查 `tasks` 表是否已存在同 ID。

## 边界

- 本目录内容只在用户明确确认后才修改，约束见 [AGENTS.md](AGENTS.md)。
