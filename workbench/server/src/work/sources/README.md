# JSON 文件工作来源

`json-file` 从管理员整理的本地导出文件读取资源，通过已有的工作包派工。接口复用 Server 的 Bearer 认证，所有持有该管理 token 的调用方均可读取配置来源的业务材料。此来源只提供 HTTP API。接入真实平台需要另行实现 SDK 同步和平台授权；定制页面也需单独开发。

## 启用

1. 发布工作包及其执行器，记下要开放的包 ID、修订号和动作名。示例使用 `triage` 的第 1 版及其中的 `inspect` 动作。
2. 准备下列两个 UTF-8 JSON 文件。使用管理员控制的本地绝对路径，目录及其祖先应禁止非受信账户替换路径。文件须为服务账户或 root 所有、服务账户可读的普通文件，组和其他账户权限为零，例如目录 `0700`、文件 `0600`。文件名处不接受符号链接。
3. 在 Server 进程环境设置 `URSI_WORK_SOURCES=/srv/ursi-private/sources.json` 并重启。配置在启动时读取。不设置该变量时不挂载来源路由。修改动作或包版本需要重启。更新资源只需在同一私有目录写好新导出文件，再原子重命名覆盖旧文件。

**来源配置** `/srv/ursi-private/sources.json`，最大 64 KiB：

```json
{
  "providers": [{
    "kind": "json-file",
    "id": "tickets",
    "file": "/srv/ursi-private/tickets.json",
    "actions": [{"action": "inspect", "package": "triage", "revision": 1}]
  }]
}
```

**资源导出** `/srv/ursi-private/tickets.json`，每个来源最大 1 MiB：

```json
[
  {"id": "T-1", "title": "订单回执缺失", "input": {"ticket": "T-1", "symptom": "未收到回执"}}
]
```

资源、来源、包和动作标识为 1 至 128 字节的字母、数字、连字符、下划线或点，不可为 `.` 或 `..`。资源 ID 在文件内唯一，动作名在来源内唯一。`input` 是工作包要使用的 JSON 对象，详情接口会返回，派工时会持久化。导出前只保留办理所需且可供管理 API 用户查看的字段，剔除凭据、令牌、原始平台响应和无关个人信息。

## 查询与派工

| 方法和路径（前缀 `/api/v2`） | 成功响应 |
| --- | --- |
| `GET /sources` | 来源数组，每项含 `id`、`kind`、`actions`（动作名数组）。 |
| `GET /sources/tickets/items` | 当前导出中的资源列表，每项只含 `id` 和 `title`。 |
| `GET /sources/tickets/items/T-1` | 单项的 `id`、`title`、`input` 及来源允许的 `actions`。 |
| `POST /sources/tickets/items/T-1/dispatch` | 工作项 `id` 和当前 `status`。首次创建为 `pending`，执行尝试为空。 |

```sh
curl -H "Authorization: Bearer $URSI_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"requestId":"ticket-T-1-receipt-01","action":"inspect"}' \
  "$URSI_API_URL/api/v2/sources/tickets/items/T-1/dispatch"
```

其中 `URSI_API_URL` 是 Server 的基址。派工请求体仅接受 `requestId` 和允许的 `action`。来源以导出文件中的 `input`、配置的包版本和动作创建工作项。来源记录为 `{"type":"connector","provider":"tickets","itemId":"T-1","action":"inspect"}`，该单后续只能办理所选动作。

资源列表、详情和派工均重新打开导出文件。一次派工重试须沿用原请求标识：来源、资源 ID、动作、包版本和输入相同则返回原单；材料等派工参数已变更则返回 `409`。资源已从导出中移除时返回 `404`，不从旧导出派工。损坏、过大、权限不合格或无法读取的导出文件返回 `503`，不回显原文或路径。已有工作项仍可从 `/api/v2/items/{id}` 查看。
