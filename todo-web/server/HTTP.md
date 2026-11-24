# 看板服务端契约

服务端读写 SUMM-Todo 的本机 SQLite 库，并向看板页面提供同源 HTTP API。所有日期字段使用 RFC 3339 字符串，统计周期按 UTC 计算。

## 配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TODO_DB_PATH` | `$HOME/.todo/todo.db` | SUMM-Todo 待办库 |
| `PORT` | `8090` | HTTP 端口，监听 `0.0.0.0` |
| `TODO_WEB_STATIC_DIR` | `../web/dist` | 静态文件目录，找不到文件时回退 `index.html` |

## 接口

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/health` | 返回 `ok` |
| `GET /api/projects?active_only=false` | 项目列表与任务计数、累计完成时间 |
| `POST /api/projects` | 新建项目，返回 `{ "id": "..." }` |
| `PUT /api/projects/{id}` | 更新项目 |
| `DELETE /api/projects/{id}` | 删除项目，任务 `project_id` 置空 |
| `GET /api/tasks?project=&status=&period=` | 任务列表 |
| `POST /api/tasks` | 新建任务，初始状态 `pending`，返回 `{ "id": "..." }` |
| `PUT /api/tasks/{id}` | 更新任务或切换状态 |
| `DELETE /api/tasks/{id}` | 删除任务 |
| `GET /api/stats?period=daily\|weekly\|monthly` | 周期统计 |

## 请求字段

项目：

```json
{ "name": "必填", "description": "可选", "path": "可选" }
```

更新项目时省略字段表示不改，传 `null` 表示清空。

任务创建：

```json
{ "title": "必填", "priority": "high|medium|low", "tags": ["..."], "project_id": "可选" }
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
  "result": "传 null 清空"
}
```

标题和项目名去掉首尾空白后不能为空。优先级和状态只接受枚举值。

## 状态时间规则

- 状态未变化时只更新提交的字段，不改写开始和完成时间。
- 切到 `pending` 清空 `started_at`、`finished_at` 和 `blocked_reason`。
- 切到 `in_progress` 在缺失时补 `started_at`，清空 `finished_at`；未显式提交阻塞原因时清空 `blocked_reason`。
- 切到 `blocked` 清空 `finished_at`。
- 切到 `done` 在缺失时补 `started_at`，写入当前 `finished_at`。
- 切到 `cancelled` 写入当前 `finished_at`。

## 查询与统计

- `GET /api/tasks` 的 `period` 只过滤已完成任务：`finished_at` 落在当天、本周一至今天或本月 1 日至今天；未完成任务不受周期限制。
- 统计的任务数只计 `status = done` 且 `finished_at` 落在周期内的记录；投入时间按 `finished_at - started_at` 累计，仅计已记录开始和完成时间的任务。
- 项目计数只统计 `pending`、`in_progress`、`blocked`、`done` 四种状态；累计时间只计已完成任务。
- 排序规则：未完成任务在前，按优先级和创建时间升序；已完成任务按完成时间降序。

## 错误

错误响应为 `{ "error": "说明" }`。输入非法返回 400，记录不存在返回 404，数据库错误返回 500。
