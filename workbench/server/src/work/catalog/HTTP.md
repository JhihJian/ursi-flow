# 工作定义目录 HTTP 契约

路由使用 `/v2/{collection}`，挂在 Server 的 `/api` 下时外部地址为 `/api/v2/{collection}`。`collection` 为 `resources`、`executors` 或 `packages`。发布失败不会占用修订号。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/v2/{collection}` | 校验并发布定义，返回新修订正文 |
| `GET` | `/v2/{collection}` | 返回各 ID 的最新版数组，每项带 `active` |
| `GET` | `/v2/{collection}/{id}` | 返回指定 ID 的最新版和 `active` |
| `GET` | `/v2/{collection}/{id}/revisions` | 从早到晚返回冻结的所有修订 |
| `GET` | `/v2/{collection}/{id}/revisions/{revision}` | 返回指定冻结修订 |
| `POST` | `/v2/{collection}/{id}/deactivate` | 停用 ID，历史读取不变 |

执行器发布正文只包含通用能力和受限配置契约：

```json
{
  "id": "assistant",
  "resources": [{"id": "guide", "revision": 1}],
  "configSchema": {
    "endpoint": {"type": "url", "default": "https://api.example.test/v1"},
    "mode": {"type": "enum", "values": ["fast", "safe"], "default": "safe"},
    "retries": {"type": "integer", "minimum": 0, "maximum": 5, "default": 2},
    "token": {"type": "secret", "default": {"ref": "secret://provider/token"}}
  }
}
```

`configSchema` 的字段类型为 `string`、`url`、`secret`、`enum`、`integer`、`number`、`boolean`。字段定义不接受任意 JSON Schema 字段，也不接受路径、程序、命令或环境变量字段。`enum` 只能使用非空且不重复的字符串 `values`。数值类型可使用有限的 `minimum` 和 `maximum`，默认值必须符合类型并落在边界内。

secret 只能以 `"***"`、`{"redacted":true}` 或内部 `{"ref":"secret://..."}` 表示。服务端不会在普通发布、列表、详情或历史响应中返回 secret 明文。凭据正文由外部密钥管理系统按内部引用解析。

```bash
api="http://127.0.0.1:8080/api/v2"
auth="Authorization: Bearer $URSI_API_TOKEN"
post() { curl -fsS -H "$auth" --json "$2" "$api/$1"; }
post resources '{"id":"guide","kind":"skill","content":"列出材料及核查结果。"}'
post executors '{"id":"assistant","resources":[{"id":"guide","revision":1}],"configSchema":{"mode":{"type":"enum","values":["fast","safe"],"default":"safe"}}}'
post packages '{"id":"triage","sop":"按材料逐项核查。","acceptance":"结论有证据。","actions":{"analyze":{"executor":{"id":"assistant","revision":1}}}}'
curl -fsS -H "$auth" "$api/packages/triage/revisions/1"
curl -fsS -X POST -H "$auth" "$api/packages/triage/deactivate"
```
