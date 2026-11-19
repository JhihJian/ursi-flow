# 虚拟目录 HTTP 接口与验收用例

路由使用 `/v2/directories`，挂在 Server 的 `/api` 下时外部地址为 `/api/v2/directories`。需要管理令牌。路径参数都是目录根相对路径，按 URL 查询参数或 JSON 字段传入，需要百分号编码。目录标识由服务端生成。

| 方法与路径 | 参数与结果 |
| --- | --- |
| `GET /v2/directories` | 目录数组，每项只有 `id`。 |
| `POST /v2/directories` | JSON：空对象 `{}`。返回 `{id}`。 |
| `GET /v2/directories/{id}` | 目录元信息 `{id}`，未知标识返回 404。 |
| `GET /v2/directories/{id}/tree` | 全树扁平数组，每项 `{path,kind,size?}`，`kind` 为 `file` 或 `dir`，`size` 只对文件存在。 |
| `GET /v2/directories/{id}/file?path=` | 原始字节，`Content-Type: application/octet-stream`。空文件返回 200 和空正文。 |
| `PUT /v2/directories/{id}/file?path=[&replace=true]` | 正文即文件字节。默认只新建，`replace=true` 才覆盖。成功返回 204。 |
| `POST /v2/directories/{id}/dir` | JSON：`path`，单建一层目录，父目录必须已存在。成功返回 204。 |
| `POST /v2/directories/{id}/move` | JSON：`from`、`to`，移动或改名，不覆盖已有目标。成功返回 204。 |
| `DELETE /v2/directories/{id}/entry?path=` | 删除文件或目录，非空目录一并删除。成功返回 204。 |

错误一律为 `{"error":"…"}`：路径或正文不合法 400，目录或条目不存在 404，覆盖未确认、移动已存在目标、触碰受固定路径保护的条目、目录已冻结 409，目录根被替换等磁盘异常 500。写入超过 8 MiB 的文件返回 400，请求体超过上限时由路由层返回 413。

## 基本操作

```bash
API=${API:-http://localhost:8080/api/v2/directories}
AUTH="Authorization: Bearer $URSI_API_TOKEN"
get() { curl -fsS -H "$AUTH" "$API$1"; }
send() { curl -fsS -H "$AUTH" -H 'Content-Type: application/json' -d "$2" "$API$1"; }
put() { curl -fsS -o /dev/null -w '%{http_code}\n' -X PUT -H "$AUTH" --data-binary @"$2" "$API$1"; }
q() { python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$1"; }

ID=$(send '' '{}' | jq -er .id)
get "/$ID" | jq -e '.id != null'
send "/$ID/dir" '{"path":"材料"}' >/dev/null
printf '101：缺少回执\n' > /tmp/finding.txt
put "/$ID/file?path=$(q 材料/finding.txt)" /tmp/finding.txt
get "/$ID/tree" | jq -e 'length == 2'
get "/$ID/file?path=$(q 材料/finding.txt)"
send "/$ID/move" '{"from":"材料/finding.txt","to":"材料/结论.md"}' >/dev/null
curl -fsS -H "$AUTH" -X PUT "$API/$ID/file?path=$(q 材料/结论.md)&replace=true" \
  --data-binary '替换后的正文' >/dev/null
curl -fsS -H "$AUTH" -X DELETE "$API/$ID/entry?path=$(q 材料)" >/dev/null
get "/$ID/tree" | jq -e 'length == 0'
```

默认只新建：对已存在的路径再次 `PUT` 不带 `replace=true` 时返回 409，原文件不变。目标父目录不存在时返回 404，接口不会隐式建目录；界面先逐级调用 `/dir` 补齐父目录。

## 路径约束

上层资源可以给目录附加约束，通过目录接口操作时同样生效。

- 固定路径不能移动或删除，移动目标也不能占用固定路径。对固定路径的上级目录做移动或删除返回 409，因为会带走固定位置；写入也不能用文件占住受保护路径的上级目录。固定目录之下的普通条目不受限制。
- 指定为 JSON 对象的路径只接受顶层为对象的合法 JSON。坏正文返回 400，原文件不变；把其他文件移动到这类路径时也会校验来源正文。

例如配置包目录的 `AGENTS.md`、`skills/` 和 `mcp.json` 是固定路径，`mcp.json` 还必须是 JSON 对象。以下请求假设 `$ID` 指向声明了这些约束的目录：

```bash
# 坏 JSON 返回 400，原文件保持不变。
curl -sS -o /dev/null -w '%{http_code}\n' -H "$AUTH" -X PUT \
  "$API/$ID/file?path=mcp.json&replace=true" --data-binary '{'
get "/$ID/file?path=mcp.json" | jq -e '.mcpServers == {}'
# 固定路径不能被移动或删除。
test "$(curl -sS -o /dev/null -w '%{http_code}' -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"from":"AGENTS.md","to":"prompt.md"}' "$API/$ID/move")" = 409
test "$(curl -sS -o /dev/null -w '%{http_code}' -H "$AUTH" -X DELETE \
  "$API/$ID/entry?path=skills")" = 409
```

## 路径与隔离

冻结目录（执行尝试结束后）的 `PUT`、`/dir`、`/move` 和 `DELETE` 返回 409，`GET` 与 `tree` 仍可读。冻结由上层资源在自己的存储更新中完成，没有独立的 HTTP 接口；工作包和配置包目录不会冻结。

- 只接受目录根相对路径：每段非空、不超过 255 字节、不是 `.` 或 `..`、不含控制字符；整条路径不超过 1024 字节、最多 32 段。绝对路径、`a//b`、`a/./b`、`a/` 都返回 400。
- 目录根或其中任意一级目录被换成符号链接时，经过该处的读写失败，目录外文件不可达；列出全树时不显示符号链接。
- 目录之间互不可见。列表和元数据不公布宿主路径。
