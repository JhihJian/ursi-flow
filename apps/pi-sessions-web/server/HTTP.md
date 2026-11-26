# 服务端接口契约

零依赖 Node 24 服务，默认监听 `0.0.0.0:30200`，同时托管 `web/dist`。全部接口只读，没有任何写入会话文件的入口。

所有接口的响应都是 `application/json; charset=utf-8` 或 `text/plain; charset=utf-8`，并带 `Cache-Control: no-store`。

## 公共约定

### 根目录参数 `root`

必填，绝对路径。服务端按顺序做三件事：`~`/`~/` 前缀展开为当前用户家目录；要求是绝对路径；要求存在且是目录。任何一步不通过都返回 400 与中文 `error`。

扫描在该目录下三层以内收集 `*.jsonl`，不跟符号链接，最多 5000 个文件。

### 会话 id

`id` 取值顺序：会话头部的 `id`，头部 `sessionId`，文件名里的 UUID（`<时间>_<uuid>.jsonl` 与 `<uuid>.jsonl`），最后是去掉 `.jsonl` 的文件名。因此没有标准头的文件也能被定位。

### 会话行

列表、单项与会话文本三条接口共用同一行形状：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 会话 id |
| `path` | string | 会话文件绝对路径 |
| `projectDir` | string | 文件所在目录名，pi 的有损编码 |
| `projectKey` | string | 有 `cwd` 时是 `cwd`，否则是 `projectDir`；分组的键 |
| `projectName` | string | `cwd` 末段，缺 `cwd` 时是去掉首尾 `-` 的目录名 |
| `cwd` | string | 会话头部的 `cwd`，没有则空串 |
| `name` | string? | `session_info` 里的改名，没有则缺省 |
| `firstMessage` | string | 首条用户消息，压成一行并截断到 200 字符 |
| `messageCount` | number | 消息行数；明细未读完时为 0 |
| `created` | number | 会话头部时间（epoch ms），缺失时取文件修改时间 |
| `modified` | number | 最后一条用户/助手消息时间，缺失时取文件修改时间 |
| `size` | number | 文件字节数 |
| `format` | `"pi" \| "legacy" \| "unknown"` | 首行判定：有 `type: "session"` 是 `pi`，老写法是 `legacy` |
| `detailsPending` | boolean | 只读了头部行，消息数与首条消息还没补 |

## `GET /api/health`

返回文本 `ok`。

## `GET /api/config`

给出界面初始值。

```json
{
  "defaultRoot": "/home/me/.pi/agent/sessions",
  "suggestedRoots": ["/home/me/.pi/agent/sessions", "/home/me/.pi/agent"],
  "maxTextBytes": 67108864
}
```

## `GET /api/sessions?root=<绝对路径>`

列出根目录下的会话，按 `modified` 倒序，相同则按路径升序。

```json
{
  "root": "/home/me/.pi/agent/sessions",
  "sessions": [],
  "pendingDetails": 3,
  "truncated": false
}
```

- `pendingDetails` 是还在等后台补明细的文件数。客户端拉到大于 0 时可再请求一次，补齐后归零。
- `truncated` 为 true 表示文件数超过上限、结果不完整。
- 首次请求只读每个文件的头部行（4KB 起、最多 64KB）；文件大小与 `mtimeMs` 都未变的会话直接复用上次结果。
- 只清理本次根目录下已消失文件的缓存，其它根目录的缓存保留。

## `GET /api/sessions/:id?root=<绝对路径>`

返回一行会话元信息，并额外带 `tooLarge`（`size > maxTextBytes`）。找不到返回 404 `{"error": "会话不存在"}`。

命中列表缓存时不再扫目录；否则只读这一个文件，或在候选文件名里按 id 匹配。

## `GET /api/sessions/:id/text?root=<绝对路径>`

返回组件库可直接解析的纯文本，逐行流式输出，`X-Session-Format` 给出格式判定。客户端带 `Accept-Encoding: gzip` 时用 `Content-Encoding: gzip` 输出。

体积超过 `maxTextBytes` 返回 413：

```json
{ "error": "会话 82MB，超过 64MB 上限" }
```

转换规则：

- 首行不是 `type: "session"` 时按首行时间、`cwd`、会话 id 合成一条行头，保证组件库拿到行头。
- 老写法的 `user`/`assistant` 行改写成 `type: "message"`，`uuid`/`parentUuid` 映射成 `id`/`parentId`；缺少时按顺序串成单链。
- 无法解析的行丢弃并计数，不让一行坏数据毁掉整个会话。
- 其它类型（`model_change`、`thinking_level_change`、`compaction`、`context_edit` 等）原样透传，组件库自行处理或忽略。

## `GET /api/browse?path=<绝对路径>`

选根浮层用。只列子目录，不递归。

```json
{
  "path": "/home/me/.pi/agent/sessions",
  "parent": "/home/me/.pi/agent",
  "dirs": [{ "name": "--data-dev-ursi-flow--", "path": "...", "sessions": 131 }]
}
```

`dirs[].sessions` 是该子目录**直接**包含的 `.jsonl` 数量，按它倒序、同数按名字升序。`parent` 在文件系统根处为 `null`。路径不存在或不可读返回 400。

## 索引缓存

扫描结果按文件指纹（`size` + `mtimeMs`）写入 `PI_SESSIONS_STATE` 指向的文件，默认 `~/.cache/pi-sessions-web/session-index.json`，权限 0600，临时文件写完再改名。

- 格式：`{ "version": 1, "entries": [{ "size", "mtimeMs", "info": <会话行> }] }`。
- 变更后延迟 5 秒合并写一次；进程收到 `SIGINT`/`SIGTERM` 时立即落盘。
- 读不进来（不存在、损坏、版本不符）就从空缓存开始，功能不受影响。
- 缓存只影响启动速度，不参与正确性判定：每次列目录都重新 `stat` 并对不上的文件重读。
