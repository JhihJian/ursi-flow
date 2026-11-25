# ssh-web server HTTP 接口

基础地址：`http://<host>:8091/api`。所有请求与响应体为 JSON（WS 帧除外）。错误响应统一为：

```json
{"error": "人类可读原因", "code": "bad_request | not_found | conflict | ssh_error | internal"}
```

`ssh_error` 对应上游 SSH 失败（连接不上、认证失败等），HTTP 状态 502。

## 连接配置

### `GET /connections`

返回连接列表，按名称不区分大小写排序。**响应不含 `password` 与 `key_passphrase`。**

```json
{"connections": [{"id": 1, "name": "spike", "host": "127.0.0.1", "port": 2299, "username": "spike", "auth_type": "password", "key_path": null, "key_passphrase": null, "created_at": "...", "updated_at": "..."}]}
```

### `POST /connections`

创建连接。必填：`name`（唯一，重复返回 409 `conflict`）、`host`、`username`；可选：`port`（默认 22）、`auth_type`（`password` | `key`，默认 `password`）、`password`、`key_path`（ssh-web 所在机器上的私钥绝对路径）、`key_passphrase`。密码认证必须提供 `password`，密钥认证必须提供 `key_path`，否则 400。

返回 `{"id": 1}`，状态 201。

### `PUT /connections/{id}`

更新连接。字段全部可选，只更新出现的字段：

- `name`/`host`/`username`/`port`/`auth_type`/`key_path`/`key_passphrase`：提供即替换，`key_path`/`key_passphrase` 传 `null` 或空串表示清空。
- `password`：唯一不回传字段。**省略、`null` 或空串都表示保持原密码**，非空串才替换。改为 key 认证时也无需传 `password`。

返回 `{"success": true}`；连接不存在返回 404。

### `DELETE /connections/{id}`

删除连接。同时终止该连接的全部活跃会话。返回 `{"success": true}`。

## 会话

### `POST /connections/{id}/connect`

建立 SSH 会话（同步等待连接、认证与 shell 就绪后返回）。

请求体可选：`{"cols": 80, "rows": 24}`（PTY 初始尺寸，1–500，默认 80×24）。

成功返回：

```json
{"session": {"id": "s-...", "connection_id": 1, "connection_name": "spike", "host": "127.0.0.1", "username": "spike", "attached": false}}
```

失败返回 502 `ssh_error`，如 `认证失败：spike`、`Connection refused (os error 111)`、`连接超时`，此时不会产生会话。

### `GET /sessions`

列出活跃会话，响应结构同上 `session` 对象，外层为 `{"sessions": [...]}`。

### `DELETE /sessions/{id}`

主动关闭会话并断开 SSH。返回 `{"success": true}`。

### `GET /sessions/{id}/ws`

接入会话终端（WebSocket 升级请求）。同一会话同一时间只接受一个 WS；接入前会话已在注册表中，接入后即进入数据泵。

**帧协议**（与 ursi-sandbox TerminalSurface 一致）：

- 客户端 → 服务端：文本帧 JSON
  - `{"type":"input","data":"..."}`：写入 PTY，单帧最长 64KiB，超长丢弃。
  - `{"type":"resize","cols":110,"rows":32}`：调整远端窗口，1–500，超界忽略。
  - 其他类型与非法 JSON 忽略。
- 服务端 → 客户端：
  - 二进制帧：终端原始字节流。
  - 文本帧 JSON 事件：`{"type":"error","message":"..."}`（泵异常）与 `{"type":"closed","message":"远端退出，exit code 0"}`（远端正常退出）。发送后服务端关闭 WS 并销毁会话。

WS 断开（无论谁先关）都会销毁会话并断开 SSH。会话不持久化，服务重启即全部失效。

### `GET /health`

返回文本 `ok`。
