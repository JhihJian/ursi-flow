# 资源与执行器定义 HTTP 契约

`collection` 为 `resources` 或 `executors`，路径相对于 `/api/v2`。

| 方法 | 路径 | 结果 |
| --- | --- | --- |
| POST | `/{collection}` | 校验并发布新修订，修订号由服务端分配 |
| GET | `/{collection}` | 各 ID 的最新版数组，含 `active` |
| GET | `/{collection}/{id}` | 最新版，含 `active` |
| GET | `/{collection}/{id}/revisions` | 从早到晚列出所有修订 |
| GET | `/{collection}/{id}/revisions/{revision}` | 指定修订正文 |
| POST | `/{collection}/{id}/deactivate` | 停用 ID，保留历史 |

例如，先发布资源 `{"id":"guide","kind":"skill","content":"列出材料及核查结果。"}`，再发布引用其首版的执行器：

```json
{
  "id": "assistant",
  "resources": [{"id": "guide", "revision": 1}],
  "configSchema": {"fields": [
    {"key": "retries", "label": "重试次数", "type": "integer", "min": 0, "max": 5, "default": 2}
  ]}
}
```

配置字段、资源种类和引用校验规则见[定义规格](SPEC.md)。工作包与配置包使用独立的[包接口](../patches/HTTP.md)。
