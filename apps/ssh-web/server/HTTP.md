# ssh-web server HTTP 接口

基础地址：`http://<host>:8091/api`。所有请求与响应体为 JSON（WS 帧除外）。错误响应统一为：

```json
{"error": "人类可读原因", "code": "bad_request | not_found | conflict | ssh_error | internal"}
```

`ssh_error` 对应上游 SSH 失败（连接不上、认证失败等），HTTP 状态 502。

## 连接配置

连接配置只有两个字段：`name`（唯一名称）与 `command`（一条 ssh 命令）。认证、跳板、端口、密钥等全部由命令本身（及 `~/.ssh/config`）表达。

### `GET /connections`

返回连接列表，按名称不区分大小写排序。

```json
{"connections": [{"id": 1, "name": "spike", "command": "ssh spike@10.0.0.5", "created_at": "...", "updated_at": "..."}]}
```

### `POST /connections`

创建连接。必填：`name`（唯一，重复返回 409 `conflict`）、`command`。`command` 首词必须是 `ssh`，否则 400。

```json
{"name": "spike", "command": "ssh -J jump@10.0.0.1 spike@10.0.0.5"}
```

返回 `{"id": 1}`，状态 201。

### `PUT /connections/{id}`

更新连接。字段全部可选，只更新出现的字段；`name`/`command` 提供即替换（校验规则同 POST）。返回 `{"success": true}`；连接不存在返回 404。

### `DELETE /connections/{id}`

删除连接。返回 `{"success": true}`。

### `GET /connections/{id}`

单条连接，预留给编辑表单回填。

## tmux 会话

服务端不维护会话注册表：WS 握手即启动一条全新 OpenSSH 子进程并 attach 到远端 tmux，会话的创建、列表、保活全部由远端 tmux 承担。

### `GET /connections/{id}/tmux-sessions`

经 ssh 在远端执行 `tmux ls` 并解析（连接命令附加 `tmux ls -F '...'` 执行一次）。返回：

```json
{"sessions": [{"name": "ssh-main", "attached": 1, "created": 1700000000}]}
```

- 远端无 tmux（`tmux` 不存在或 exit 127）：`{"sessions": null}`。
- 有 tmux 但无会话（exit 1）：`{"sessions": []}`。
- SSH 失败（不可达、认证失败等）：502 `ssh_error`。

### `GET /connections/{id}/terminal?tmux_session=<name>&cols=<n>&rows=<n>`

WebSocket 升级请求，启动一条全新 OpenSSH 子进程并 attach：

- 不带 `tmux_session`：执行 `tmux new -A -s ssh-main`（默认会话，不存在则新建）。
- 带 `tmux_session`：执行 `tmux new -A -s <name>`。会话名服务端白名单校验（ASCII 字母数字下划线连字符，1–64），非法返回 400 `bad_request` 后拒绝升级。
- `cols`/`rows`（可选）：PTY 初始尺寸，取自前端终端面板实际大小，2–500，缺省或非法回退 80×24。
- ssh 以 `ssh -tt` 运行，强制分配远端 PTY；`StrictHostKeyChecking=accept-new` 首次连接自动接受主机密钥。
- 认证失败、主机不可达等错误原样经 WS 下发（OpenSSH 自身 stderr 输出），由前端红色内联显示。
- 远端无 tmux 时由远端侧一行启动命令回退普通 shell（终端内黄色提示），服务端不解析输出。

**帧协议**：

- 客户端 → 服务端：文本帧 JSON
  - `{"type":"input","data":"..."}`：写入 PTY stdin，单帧最长 64KiB，超长丢弃。
  - `{"type":"resize","cols":110,"rows":32}`：经本地 PTY 的 ioctl 调整窗口尺寸并触发 `SIGWINCH`，随 ssh `-tt` 同步到远端，2–500，超界忽略。
  - 其他类型与非法 JSON 忽略。
- 服务端 → 客户端：
  - 二进制帧：终端原始字节流（stdout/stderr 合并）。
  - 文本帧 JSON 事件：`{"type":"error","message":"..."}` 与 `{"type":"closed","message":"ssh 已退出，exit code 0"}`。发送后服务端关闭 WS 并终止子进程；远端 tmux 会话不受影响，重连即恢复。

WS 断开即终止 ssh 子进程，服务端无任何会话状态；持久性完全由远端 tmux 承担。

### `GET /health`

返回文本 `ok`。
