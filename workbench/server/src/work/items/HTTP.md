# 工作项 HTTP 接口与验收用例

路由使用 `/v2/items`，挂在 Server 的 `/api` 下时，外部地址为 `/api/v2/items`。示例使用 Bash、curl 和 jq，假设 `triage` 第 1 版已发布，输入为 `ticket`，快照声明 `"deliverables":["report.txt"]`。数组中的每个文件都必须随本版提交。

| 方法与路径 | 参数与结果 |
| --- | --- |
| `POST /v2/items` | JSON：`requestId`、`package`、`revision`、`input` 对象、可选 `source` 对象。默认来源为 `{"type":"builtin"}`。同一请求标识和参数返回原工作项的当前详情，参数不同返回 409。 |
| `GET /v2/items?status=working` | 返回摘要数组，含 `id`、`package`、`revision`、`status`、`assignee`、`source`。省略 `status` 查全部。 |
| `GET /v2/items/{id}` | 返回包快照、来源、输入、经办人、尝试、历版交付和验收意见。 |
| `POST /v2/items/{id}/start` | `{"assignee":"Lin"}`，从 `pending` 转为 `working`。 |
| `POST /v2/items/{id}/deliveries` | `files` 为文件名到 UTF-8 正文的对象，`attemptIds` 为可选的本单来源尝试 ID 数组。文件名使用单个名称，文件正文至少含一个非空白字符。收存文件后由 `working` 转为 `review`。 |
| `GET /v2/items/{id}/deliveries/{version}/files/{name}` | 返回指定版本的文件正文（`text/plain`）；文件名按 URL 路径段编码。 |
| `POST /v2/items/{id}/deliveries/{version}/review` | `decision` 为 `accept` 或 `reject`。`reviewer` 必填，退回时 `comment` 必填。仅 `review` 状态的当前版本可审；通过后 `acceptedVersion` 记录版本，退回后回到 `working`。 |

写操作成功均返回 HTTP 200 与工作项详情。版本从 1 起算。业务状态冲突为 409，工作项或文件不存在为 404。经办人和验收人是业务记录；接口沿用部署级身份验证。

## 同一包办理两张单

```bash
API=${API:-http://localhost:8080/api/v2/items}
AUTH="Authorization: Bearer $URSI_API_TOKEN"
post() { curl -fsS -H "$AUTH" -H 'Content-Type: application/json' -d "$2" "$API$1"; }
get() { curl -fsS -H "$AUTH" "$API$1"; }

a='{"requestId":"triage-101","package":"triage","revision":1,"input":{"ticket":"101"}}'
b='{"requestId":"triage-102","package":"triage","revision":1,"input":{"ticket":"102"}}'
A=$(post '' "$a" | jq -er .id)
B=$(post '' "$b" | jq -er .id)
test "$A" != "$B"
test "$(post '' "$a" | jq -er .id)" = "$A"
post "/$A/start" '{"assignee":"Lin"}'
post "/$B/start" '{"assignee":"Mei"}'
post "/$A/deliveries" '{"files":{"report.txt":"101：已复核"}}'
post "/$A/deliveries/1/review" '{"decision":"accept","reviewer":"Chen"}'
post "/$B/deliveries" '{"files":{"report.txt":"102：初稿"}}'
post "/$B/deliveries/1/review" '{"decision":"reject","reviewer":"Chen","comment":"请补复核结果"}'
get '?status=delivered' | jq -e --arg id "$A" 'any(.[]; .id == $id)'
get "/$B" | jq -e '.status == "working" and .deliveries[0].review.comment == "请补复核结果"'
```

以相同数据目录重启 Server，保留 `A`、`B` 两个 ID，继续检查：

```bash
test "$(get "/$A/deliveries/1/files/report.txt")" = '101：已复核'
post "/$B/deliveries" '{"files":{"report.txt":"102：复核结果已补齐"}}'
# 初稿页面迟到的通过请求返回 409，第二版仍待验收。
code=$(curl -sS -o /dev/null -w '%{http_code}' -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"decision":"accept","reviewer":"Chen"}' "$API/$B/deliveries/1/review")
test "$code" = 409
test "$(get "/$B/deliveries/1/files/report.txt")" = '102：初稿'
post "/$B/deliveries/2/review" '{"decision":"accept","reviewer":"Chen"}' | jq -e '.acceptedVersion == 2'
test "$(get "/$B/deliveries/2/files/report.txt")" = '102：复核结果已补齐'
```
