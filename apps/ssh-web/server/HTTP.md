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

### `POST /connections/import`

批量创建连接（供 ssh config 批量导入）。请求体：

```json
{"connections": [{"name": "nm105", "command": "ssh -p 10000 root@nm105"}]}
```

每条独立校验（规则同 POST）与插入：单条失败不阻断其余，被跳过的条目原样返回提交名（空名用占位）与原因（同名冲突、命令不合法）。返回：

```json
{"imported": [{"id": 7}, {"id": 8}], "failed": [{"name": "nm105", "reason": "同名连接已存在"}]}
```

### `GET /ssh-config/hosts`

从服务端本机 `~/.ssh/config` 发现可批量导入的主机：`grep ^Host` 列出具体 Host 别名（跳过 `*`/`?`/`!` 通配模式），逐台 `ssh -G`（`BatchMode=yes`，单台 5 秒超时）解析最终生效的 user 与非默认 port；Include、别名、Match 都由 OpenSSH 自身解释。单台解析失败跳过且不影响其余。config 不存在或无 Host 行时返回空数组。返回：

```json
{"hosts": [{"host": "nm105", "user": "root", "port": 10000}, {"host": "mac", "user": "jhihjian", "port": null}]}
```

`port` 仅在解析结果非默认 22 时返回数值，否则为 null（前端按无 `-p` 处理）。

### `POST /connections/test`

保存前的连接自检：只验证传输层与认证，不读远端 tmux、不写库。批量 ssh（`BatchMode=yes`）执行一次 `hostname`，`command` 校验规则同 POST。返回：

```json
{"ok": true, "detail": "bogon"}
{"ok": false, "detail": "ssh 连接失败：ssh: Could not resolve hostname bad-host: ..."}
```

`ok` 为 true 时 `detail` 是远端主机名，否则是 OpenSSH 的失败原因。HTTP 状态恒为 200：连不上是自检结果而不是接口错误。需要交互密码的远端在这里会因 `BatchMode=yes` 报认证失败，这类连接仍可由用户在确认后保存，再到终端里输入密码。

### `PUT /connections/{id}`

更新连接。字段全部可选，只更新出现的字段；`name`/`command` 提供即替换（校验规则同 POST）。返回 `{"success": true}`；连接不存在返回 404。

### `DELETE /connections/{id}`

删除连接。返回 `{"success": true}`。

### `GET /connections/{id}`

单条连接，预留给编辑表单回填。

### `GET /connections/by-name/{name}/ssh-args`

按连接名取这条连接的 ssh 调用参数。`name` 就是位置契约 `ssh://<设备名>/path` 里的设备名，调用方（fs-web 的远程目录 provider）从 URI 解出设备名后到这里换取实际连机器的参数，自己拼到 `ssh` 后面执行。本服务是设备注册表的拥有者，调用方不读 `~/.ssh/config`、不缓存连接清单。

```json
{"id": 1, "name": "nm105", "args": ["-p", "10000", "root@nm105"]}
```

`args` 是连接 `command` 去掉首词 `ssh` 与 `-t`/`-tt` 之后的参数，其余（`-p`、`-i`、`-J`、config 别名等）原样保留、顺序不变。去掉 `-t`/`-tt` 是因为是否分配 PTY 由调用方决定：批量执行带 `-t` 会让远端输出混入 CRLF。

- `name` 不符合设备名规则 `[A-Za-z0-9][A-Za-z0-9._-]*`：400 `bad_request`，不查库。`user@host`、`host:port` 都在这里被拒，用户与端口归连接命令表达。
- 设备名合法但没有这个连接：404 `not_found`。

设备名大小写敏感，`nm105` 与 `NM105` 是两个连接，与位置契约一致。

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

### `DELETE /connections/{id}/tmux-sessions/{name}`

移除远端 tmux 会话：经 ssh 在远端执行 `tmux kill-session -t <name>`（批量调用，`BatchMode=yes`）。会话内进程随之结束；前端把打开中的对应标签一并关闭。返回 `{"success": true}`。

- 会话名与终端 WS 同一白名单（ASCII 字母数字下划线连字符，1–64），非法返回 400 `bad_request`。
- 会话不存在等 tmux 自身失败：502 `ssh_error`，消息附 tmux 的 stderr（如 `can't find session`）。
- SSH 失败（退出码 255）：502 `ssh_error`，消息附 OpenSSH 自身 stderr。

### `GET /connections/{id}/tmux-sessions/{name}/windows`

列出一个 tmux 会话内的 window（tmux 状态栏里的「标签」）：远端执行 `tmux list-windows -t <name> -F '{window_index}|{window_name}|{window_active}|{window_panes}'`。返回：

```json
{"windows": [{"index": 0, "name": "bash", "active": true, "panes": 1}]}
```

- 远端无 tmux：`{"windows": null}`，前端不渲染 window 条。
- 会话不存在（exit 1）：`{"windows": []}`。
- SSH 失败（退出码 255）：502 `ssh_error`，消息附 OpenSSH 自身 stderr。

### `POST /connections/{id}/tmux-sessions/{name}/windows`

新建 window：远端执行 `tmux new-window [-n <name>] -t <name>:`（名称可空，tmux 默认以当前程序命名）。返回 `{"success": true}`。名称与服务名同一白名单，非法返回 400 `bad_request`；会话不存在等失败为 502 `ssh_error`。

### `POST /connections/{id}/tmux-sessions/{name}/windows/{index}/select`

切换会话的当前 window（`tmux select-window -t <name>:<index>`）。作用于远端 tmux server：正在 attach 的终端立即收到新画面。返回 `{"success": true}`；序号限 0–999，越界返回 400。

### `DELETE /connections/{id}/tmux-sessions/{name}/windows/{index}`

关闭 window（`tmux kill-window -t <name>:<index>`），其中窗格进程一并结束。返回 `{"success": true}`；失败语义同上。

### `GET /connections/{id}/terminal?tmux_session=<name>&cwd=<path>&cols=<n>&rows=<n>`

WebSocket 升级请求，启动一条全新 OpenSSH 子进程并 attach：

- 不带 `tmux_session`：执行 `tmux new -A -s ssh-main`（默认会话，不存在则新建）。
- 带 `tmux_session`：执行 `tmux new -A -s <name>`。会话名服务端白名单校验（ASCII 字母数字下划线连字符，1–64），非法返回 400 `bad_request` 后拒绝升级。
- `cwd`（可选）：远端初始目录，设备内绝对路径（如 `/srv/app`），供「在设备的这个目录打开终端」这类跨模块调用使用。校验规则：以 `/` 开头，不含 `'`、`\`、NUL、换行，不超过 4096 字节，否则 400 `bad_request`（空串按未提供处理）。
  - 不带 `cwd`：行为同上，初始目录由 tmux 自己决定（会话已有则以会话当前 window 为准）。
  - 带 `cwd`：`-c` 只在 tmux **新建会话**时生效，会话已存在时会被静默忽略，所以远端先 `tmux has-session -t <name>` 分流：
    - 会话不存在：`tmux new -A -s <name> -c <cwd>`，新会话落在该目录。
    - 会话已存在：`tmux new-window -t <name>: -c <cwd> && tmux attach -t <name>`，在会话里新开一个落在该目录的 window 再 attach。同一会话以不同 `cwd` 多次打开，每次都会多一个 window。
    - 远端无 tmux：`cd <cwd> 2>/dev/null; exec $SHELL`，回退的普通 shell 也落在该目录。
  - `cwd` 指向的目录不存在时 tmux 不报错，shell 落在登录目录；回退 shell 同理（`cd` 失败静默）。终端照常可用。
  - `cwd` 只在握手时生效一次：已打开的终端 WS 不会因再次传 `cwd` 而换目录。
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
