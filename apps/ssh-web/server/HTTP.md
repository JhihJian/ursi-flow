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

经 ssh 在远端执行 `tmux ls` 并解析（连接命令附加 `tmux ls -F '...'` 执行一次）。批量调用以 `-o BatchMode=yes` 运行，要求密钥 / agent 免交互认证：需要交互密码的远端在这里直接返回认证失败，交互密码仍可在终端会话里输入。每轮先 `command -v tmux` 显式探测：tmux 不存在时由远端脚本打印固定标记，服务端据此返回 `null`（不依赖找不到命令时的退出码）。返回：

```json
{"sessions": [{"name": "ssh-main", "attached": 1, "created": 1700000000}]}
```

- 远端无 tmux：`{"sessions": null}`，前端据此列出 Linux（apt/dnf）与 macOS（brew）安装命令。
- 有 tmux 但无会话（exit 1）：`{"sessions": []}`。
- SSH 失败（不可达、认证失败、主机密钥问题等，ssh 退出码 255）：502 `ssh_error`，错误消息附 OpenSSH 自身 stderr，不再笼统报“tmux ls 异常退出”。

### `GET /connections/{id}/terminal?tmux_session=<name>&cols=<n>&rows=<n>`

WebSocket 升级请求，启动一条全新 OpenSSH 子进程并 attach：

- 不带 `tmux_session`：执行 `tmux new -A -s ssh-main`（默认会话，不存在则新建）。
- 带 `tmux_session`：执行 `tmux new -A -s <name>`。会话名服务端白名单校验（ASCII 字母数字下划线连字符，1–64），非法返回 400 `bad_request` 后拒绝升级。
- `cols`/`rows`（可选）：PTY 初始尺寸，取自前端终端面板实际大小，2–500，缺省或非法回退 80×24。
- ssh 以 `ssh -tt` 运行，强制分配远端 PTY；`StrictHostKeyChecking=accept-new` 首次连接自动接受主机密钥。
- 认证失败、主机不可达等错误原样经 WS 下发（OpenSSH 自身 stderr 输出），由前端红色内联显示。
- 远端无 tmux 时由远端侧一行启动命令回退普通 shell：终端内黄色提示首行说明已回退、次行给出 Debian/Ubuntu `sudo apt install tmux`、Fedora/RHEL `sudo dnf install tmux` 与 macOS `brew install tmux`；服务端不解析输出。

**帧协议**：

- 客户端 → 服务端：文本帧 JSON
  - `{"type":"input","data":"..."}`：写入 PTY stdin，单帧最长 64KiB，超长丢弃。
  - `{"type":"resize","cols":110,"rows":32}`：经本地 PTY 的 ioctl 调整窗口尺寸并触发 `SIGWINCH`，随 ssh `-tt` 同步到远端，2–500，超界忽略。
  - 其他类型与非法 JSON 忽略。
- 服务端 → 客户端：
  - 二进制帧：终端原始字节流（stdout/stderr 合并）。
  - 文本帧 JSON 事件：`{"type":"error","message":"..."}` 与 `{"type":"closed","message":"ssh 已退出，exit code 0"}`。发送后服务端关闭 WS 并终止子进程；远端 tmux 会话不受影响，重连即恢复。

WS 断开即终止 ssh 子进程，服务端无任何会话状态；持久性完全由远端 tmux 承担。

## 设备资源采样

服务端不缓存采样：每次请求就是一轮独立的批量 ssh（不分配 PTY）。远端先读两次 `/proc/stat` 算 CPU 使用率，再逐行输出 `key value`，随后在 ssh 通道上做一次问答应答量出网络往返延迟。

### `GET /connections/{id}/metrics`

采样一台连接中设备的资源：

```json
{
  "hostname": "host-1",
  "cores": 8,
  "load1": 0.42,
  "load5": 0.38,
  "load15": 0.3,
  "cpu_percent": 12.7,
  "mem_total_kb": 16384000,
  "mem_available_kb": 9200000,
  "mem_free_kb": 3100000,
  "swap_total_kb": 2097152,
  "swap_free_kb": 2097152,
  "disk": { "total_kb": 102400000, "used_kb": 63488000 },
  "uptime_secs": 3865349,
  "net_rx_bytes": 540763071345,
  "net_tx_bytes": 518578085308,
  "latency_ms": 7.3,
  "processes": [
    { "pid": 1234, "name": "node", "mem_percent": 5.6, "rss_kb": 1148888 }
  ],
  "sampled_at": "2025-11-26T13:34:05.386Z"
}
```

- `load1` / `load5` / `load15`：远端 `/proc/loadavg` 前三列。
- `cpu_percent`：同一轮里两次 `/proc/stat`（间隔 0.25s）的忙碌占比，取不到内核计数时为 `null`。
- `mem_total_kb` / `mem_available_kb` / `mem_free_kb`：`/proc/meminfo` 的 `MemTotal` / `MemAvailable` / `MemFree`；已用 = Total - Available，可回收缓存 = Available - Free。
- `swap_total_kb` / `swap_free_kb`：`/proc/meminfo` 的 `SwapTotal` / `SwapFree`。
- `disk`：`df -kP /` 的总量与已用；`df` 不可用时为 `null`。
- `uptime_secs`：`/proc/uptime` 第一列。
- `net_rx_bytes` / `net_tx_bytes`：所有非 `lo` 网卡的累计字节数，速率由调用方按两次采样的差值除以时间得到。
- `latency_ms`：在 ssh 通道上做一次一问一答的往返耗时（毫秒，一位小数），不含 ssh 握手；4 秒内没有应答时为 `null`。
- `processes`：`ps -eo pid=,pmem=,rss=,comm= --sort=-rss` 的前 5 行（按常驻内存降序）；`ps` 不支持或失败时为空数组。
- `cores`：`nproc`，缺失时回退 `getconf _NPROCESSORS_ONLN`，仍取不到按 1 计。
- `sampled_at`：服务端采样时刻（RFC 3339，毫秒精度）。

整轮采样 15 秒超时，同样以 `-o BatchMode=yes` 批量执行，需要免交互认证。SSH 失败（不可达、认证失败）或远端缺少 `/proc` 数据返回 502 `ssh_error`，消息里附 ssh 自身的 stderr（截断到 400 字符）。

### `GET /health`

返回文本 `ok`。
