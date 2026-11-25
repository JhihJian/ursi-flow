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

删除连接。返回 `{"success": true}`。

## tmux 会话

服务端不维护会话注册表：WS 握手即建立一条全新 SSH 连接并 attach 到远端 tmux，会话的创建、列表、保活全部由远端 tmux 承担。

### `GET /connections/{id}/tmux-sessions`

实时执行远端 `tmux ls` 并解析。返回：

```json
{"sessions": [{"name": "ssh-main", "attached": 1, "created": 1700000000}]}
```

- 远端无 tmux（`tmux` 不存在或 exit 127）：`{"sessions": null}`。
- 有 tmux 但无会话（exit 1）：`{"sessions": []}`。
- SSH 失败（不可达、认证失败等）：502 `ssh_error`。

### `GET /connections/{id}/terminal?tmux_session=<name>&cols=<n>&rows=<n>`

WebSocket 升级请求，建立一条全新 SSH 连接并 attach：

- 不带 `tmux_session`：执行 `tmux new -A -s ssh-main`（默认会话，不存在则新建）。
- 带 `tmux_session`：执行 `tmux new -A -s <name>`。会话名服务端白名单校验（ASCII 字母数字下划线连字符，1–64），非法返回 400 `bad_request` 后拒绝升级。
- `cols`/`rows`（可选）：PTY 初始尺寸，取自前端终端面板实际大小，2–500，缺省或非法回退 80×24。PTY 以该尺寸创建，避免终端闪排。
- 远端无 tmux 时由远端侧一行启动命令回退普通 shell（终端内黄色提示），服务端不解析输出。

**帧协议**：

- 客户端 → 服务端：文本帧 JSON
  - `{"type":"input","data":"..."}`：写入 PTY，单帧最长 64KiB，超长丢弃。
  - `{"type":"resize","cols":110,"rows":32}`：调整远端窗口，1–500，超界忽略。
  - 其他类型与非法 JSON 忽略。
- 服务端 → 客户端：
  - 二进制帧：终端原始字节流。
  - 文本帧 JSON 事件：`{"type":"error","message":"..."}`（SSH 失败，如 `认证失败：spike`）与 `{"type":"closed","message":"远端退出，exit code 0"}`（tmux 会话结束或普通 shell 退出）。发送后服务端关闭 WS 并断开 SSH；远端 tmux 会话不受影响，重连即恢复。

WS 断开即断开 SSH，服务端无任何会话状态；持久性完全由远端 tmux 承担。

### `GET /health`

返回文本 `ok`。
