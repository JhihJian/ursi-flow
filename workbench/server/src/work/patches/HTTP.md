# 包目录 HTTP 接口与验收用例

路由使用 `/v2/patches`，挂在 Server 的 `/api` 下时外部地址为 `/api/v2/patches`。`{kind}` 取 `work` 或 `config`。所有路径参数都是包根相对路径，按 URL 查询参数或 JSON 字段传入，需要百分号编码。

| 方法与路径 | 参数与结果 |
| --- | --- |
| `GET /v2/patches/{kind}` | 包数组，每项只有 `id` 和 `name`。 |
| `POST /v2/patches/{kind}` | JSON：`name`。返回 `{id,name}`，标识由服务端生成。 |
| `GET /v2/patches/{kind}/{id}/tree` | 全树扁平数组，每项 `{path,kind,size?}`，`kind` 为 `file` 或 `dir`，`size` 只对文件存在。 |
| `GET /v2/patches/{kind}/{id}/file?path=` | 原始字节，`Content-Type: application/octet-stream`。空文件返回 200 和空正文。 |
| `PUT /v2/patches/{kind}/{id}/file?path=[&replace=true]` | 正文即文件字节。默认只新建，`replace=true` 才覆盖。成功返回 204。 |
| `POST /v2/patches/{kind}/{id}/dir` | JSON：`path`，单建一层目录，父目录必须已存在。成功返回 204。 |
| `POST /v2/patches/{kind}/{id}/move` | JSON：`from`、`to`，移动或改名，不覆盖已有目标。成功返回 204。 |
| `DELETE /v2/patches/{kind}/{id}/entry?path=` | 删除文件或目录，非空目录一并删除。成功返回 204。 |

错误一律为 `{"error":"…"}`：路径或正文不合法 400，包或条目不存在 404，包名冲突或覆盖未确认、移动已存在目标、触碰配置锚点 409，包根被替换等磁盘异常 500。写入超过 8 MiB 的文件返回 400，请求体超过上限时由路由层返回 413。

## 工作包

```bash
API=${API:-http://localhost:8080/api/v2/patches}
AUTH="Authorization: Bearer $URSI_API_TOKEN"
get() { curl -fsS -H "$AUTH" "$API$1"; }
send() { curl -fsS -H "$AUTH" -H 'Content-Type: application/json' -d "$2" "$API$1"; }
put() { curl -fsS -o /dev/null -w '%{http_code}\n' -X PUT -H "$AUTH" --data-binary @"$2" "$API$1"; }
q() { python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$1"; }

ID=$(send /work '{"name":"结算异常排查"}' | jq -er .id)
send "/work/$ID/dir" '{"path":"材料"}' >/dev/null
printf '101：缺少回执\n' > /tmp/finding.txt
put "/work/$ID/file?path=$(q 材料/finding.txt)" /tmp/finding.txt
get "/work/$ID/tree" | jq -e 'length == 2'
get "/work/$ID/file?path=$(q 材料/finding.txt)"
send "/work/$ID/move" '{"from":"材料/finding.txt","to":"材料/结论.md"}' >/dev/null
curl -fsS -H "$AUTH" "$API/work/$ID/file?path=$(q 材料/结论.md)&replace=true" \
  --data-binary '替换后的正文' >/dev/null
curl -fsS -H "$AUTH" -X DELETE "$API/work/$ID/entry?path=$(q 材料)" >/dev/null
get "/work/$ID/tree" | jq -e 'length == 0'
```

默认只新建：对已存在的路径再次 `PUT` 不带 `replace=true` 时返回 409，原文件不变。目标父目录不存在时返回 404，接口不会隐式建目录；界面先逐级调用 `/dir` 补齐父目录。

## 配置包

新建配置包后立即有三个锚点，写入 `mcp.json` 必须是 JSON 对象，锚点不能被移动或删除。

```bash
CID=$(send /config '{"name":"审核助手"}' | jq -er .id)
get "/config/$CID/tree" | jq -e 'map(.path) == ["AGENTS.md","mcp.json","skills"]'
get "/config/$CID/file?path=mcp.json" | jq -e '.mcpServers == {}'
curl -fsS -H "$AUTH" "$API/config/$CID/file?path=mcp.json&replace=true" \
  --data-binary '{"mcpServers":{"tools":{"command":"local-mcp"}}}' >/dev/null
# 坏 JSON 返回 400，原文件保持不变。
curl -sS -o /dev/null -w '%{http_code}\n' -H "$AUTH" \
  "$API/config/$CID/file?path=mcp.json&replace=true" --data-binary '{'
get "/config/$CID/file?path=mcp.json" | jq -e '.mcpServers.tools.command == "local-mcp"'
send "/config/$CID/dir" '{"path":"skills/review"}' >/dev/null
printf -- '---\nname: review\n---\n' > /tmp/SKILL.md
put "/config/$CID/file?path=$(q skills/review/SKILL.md)" /tmp/SKILL.md
# 三个锚点受保护：移动或删除返回 409。
test "$(curl -sS -o /dev/null -w '%{http_code}' -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"from":"AGENTS.md","to":"prompt.md"}' "$API/config/$CID/move")" = 409
test "$(curl -sS -o /dev/null -w '%{http_code}' -H "$AUTH" -X DELETE \
  "$API/config/$CID/entry?path=skills")" = 409
```

## 路径与隔离

- 只接受包根相对路径：每段非空、不超过 255 字节、不是 `.` 或 `..`、不含控制字符；整条路径不超过 1024 字节、最多 32 段。绝对路径、`a//b`、`a/./b`、`a/` 都返回 400。
- 用另一类包的标识访问 `/patches/work/{config-id}` 返回 404；两类包的内容互不可见。
- 包根或其中任意一级目录被换成符号链接时，经过该处的读写失败，包外文件不可达；列出全树时不显示符号链接。
