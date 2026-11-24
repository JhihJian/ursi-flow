# 看板服务端契约

服务端读写 SUMM-Todo 的本机 SQLite 库，并向看板页面提供同源 HTTP API。任务与项目的实体定义来自本目录 [`core`](../core/src/task.rs) crate（`todo-core`，最早来自 SUMM-Todo），看板不再维护自己的字段表、枚举和状态机。所有日期字段使用 RFC 3339 字符串，统计周期按 UTC 计算。

## 配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TODO_DB_PATH` | `$HOME/.todo/todo.db` | SUMM-Todo 待办库 |
| `PORT` | `8090` | HTTP 端口，监听 `0.0.0.0` |
| `TODO_WEB_STATIC_DIR` | `../web/dist` | 静态文件目录，找不到文件时回退 `index.html` |

## 实体

实体即 `todo_core::Task` 与 `todo_core::Project`，序列化后原样返回。可选字段为空时省略键（与 `todo --json` 一致），前端按缺失或 `null` 处理。

任务（`Task`）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 8 位十六进制 ID，由 `todo_core::generate_id` 生成 |
| `title` | string | 标题，非空 |
| `content` | string? | 正文 |
| `project_id` | string? | 所属项目，空表示未归属 |
| `creator` | `human` \| `agent` | 创建者 |
| `created_at` | datetime | 创建时间 |
| `priority` | `high` \| `medium` \| `low` | 优先级 |
| `tags` | string[] | 标签 |
| `parent_id` | string? | 父任务 |
| `pre_id` | string? | 前置任务，顺序依赖 |
| `due` | datetime? | 截止时间 |
| `status` | `pending` \| `in_progress` \| `blocked` \| `done` \| `cancelled` | 状态 |
| `assignee` | `human` \| `agent`? | 执行者 |
| `blocked_reason` | string? | 阻塞原因 |
| `result` | string? | 完成结果 |
| `artifacts` | string[] | 产出物 |
| `log` | string? | 执行日志 |
| `started_at` | datetime? | 开始时间 |
| `finished_at` | datetime? | 完成或取消时间 |
| `updated_at` | datetime? | 更新时间 |

项目（`Project`）：`id`、`name`、`description?`、`path?`、`created_at`、`updated_at?`。

## 接口

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/health` | 返回 `ok` |
| `GET /api/projects?active_only=false` | 项目列表，附状态计数与累计完成时间 |
| `POST /api/projects` | 新建项目，返回 `{ "id": "..." }` |
| `PUT /api/projects/{id}` | 更新项目 |
| `DELETE /api/projects/{id}` | 删除项目，任务 `project_id` 置空 |
| `GET /api/tasks?project=&status=&period=&date=` | 任务列表，`date` 为 `YYYY-MM-DD` |
| `POST /api/tasks` | 新建任务，初始状态 `pending`，返回 `{ "id": "..." }` |
| `PUT /api/tasks/{id}` | 更新任务或切换状态 |
| `DELETE /api/tasks/{id}` | 删除任务 |
| `GET /api/stats?period=daily\|weekly\|monthly\|all` | 周期统计 |
| `GET /api/stats/daily?days=7&project=` | 最近 `days` 天每天创建的任务数，缺失日期补 0 |

项目计数以 `{ "task_count": { "pending", "in_progress", "blocked", "done", "cancelled" }, "total_time_minutes" }` 与项目字段平铺返回。

## 请求字段

项目：

```json
{ "name": "必填", "description": "可选", "path": "可选" }
```

任务创建：

```json
{
  "title": "必填",
  "priority": "high|medium|low",
  "tags": ["..."],
  "project_id": "可选",
  "workspace": "可选，关联工作区",
  "session_id": "可选，关联会话 ID"
}
```

任务更新：

```json
{
  "title": "可选",
  "priority": "high|medium|low",
  "status": "pending|in_progress|blocked|done|cancelled",
  "tags": ["..."],
  "project_id": "传 null 解除归属",
  "blocked_reason": "传 null 清空",
  "result": "传 null 清空",
  "workspace": "传 null 清空",
  "session_id": "传 null 清空"
}
```

更新时省略字段表示不改，传 `null` 表示清空。标题和项目名去掉首尾空白后不能为空；`priority` 与 `status` 只接受枚举值，非法值在反序列化阶段即返回 400。看板不提供 `content`、`parent_id`、`pre_id`、`due`、`assignee`、`artifacts`、`log` 的写入，读取时原样返回，写回时保持不变。

## 状态机

状态迁移直接调用 `todo_core::Task::transition`，规则与 SUMM-Todo CLI 完全一致：

| 当前状态 | 允许迁移到 | 副作用 |
| --- | --- | --- |
| `pending` | `in_progress`、`cancelled` | 进入进行中写 `started_at`；取消写 `finished_at` |
| `in_progress` | `done`、`blocked`、`cancelled`、`pending` | 完成需要 `result`，写 `finished_at`；阻塞需要 `blocked_reason`；回到 `pending` 清空 `assignee` 与 `started_at` |
| `blocked` | `in_progress`、`cancelled` | 恢复清空 `blocked_reason`；取消写 `finished_at` |
| `done` | `in_progress` | 撤销完成，清空 `result`、`artifacts`、`log` 与 `finished_at` |
| `cancelled` | 无 | 终态 |

同一状态重复提交是幂等的，不会改写开始和完成时间。其余迁移返回 `E_INVALID_TRANSITION`。字段编辑不触发状态机，只有 `status` 提交且与当前状态不同时才迁移。

## 元信息字段

`workspace` 与 `session_id` 是看板新增的自由字符串字段，可为空。服务端启动时检查 `tasks` 表，缺这两列会自动 `ALTER TABLE tasks ADD COLUMN ... TEXT`；旧库无需手工迁移。空字符串按未设置处理。

## 查询与统计

- `GET /api/tasks` 的 `period` 只过滤已完成与已取消任务：`finished_at` 落在当天、本周一至今天或本月 1 日至今天；未完成任务不受周期限制；`all` 表示不限时间。
- `GET /api/tasks` 的 `date` 按任务创建日期过滤，日期格式错误返回 400。调用方在按天筛选时只传 `date`，不传 `period`。
- `GET /api/stats/daily` 的 `days` 取 1 到 31，默认 7，按创建日期统计；`project` 缺省时统计全部项目。
- 排序：未完成在前，按优先级和创建时间升序；已完成与已取消按 `finished_at` 降序。
- 统计的任务数与投入时间只计 `status = done` 且 `finished_at` 落在周期内的记录，投入时间按 `finished_at - started_at` 累计。
- `by_status` 覆盖全部五种状态：`done` 与 `cancelled` 按完成时间落周期，其余按创建时间。
- 项目计数统计全部五种状态，累计时间只计已完成任务。

## 库结构

看板不建库、不迁移。启动时检查库中确实存在 `tasks` 与 `projects` 表，之后每次读写只使用库里实际存在的列：缺列按实体默认值读取，写入时跳过，因此可以读写包含或不包含 `pre_id`、`updated_at` 等后加列的待办库。

## 错误

错误响应为 `{ "error": "说明", "code": "错误码" }`。输入非法或状态迁移被拒绝返回 400，记录不存在返回 404，数据库错误返回 500。状态机相关错误码沿用 `todo_core::TodoError::code()`：`E_INVALID_TRANSITION`、`E_RESULT_REQUIRED`、`E_BLOCKED_REASON_REQUIRED`、`E_PARSE_ERROR`，其余输入错误为 `E_INVALID_INPUT`。
