# Pi 会话心跳扩展

把 pi 进程里的会话运行态写成文件，让 pi-web 这类旁路进程能看见某个 pi home 下有哪些会话活着。

## 安装

复制或软链到目标 pi home 的 `extensions/` 目录：

```bash
ln -s /data/dev/ursi-flow/apps/pi-web/extension/pi-session-heartbeat.ts \
  ~/.pi/agent/extensions/pi-session-heartbeat.ts
```

已运行的 pi 会话需要 `/reload` 或新开会话才会加载。

## 读写约定

每个会话一个文件：

```
<pi home>/state/running-sessions/<sessionId>.json
```

字段：

| 字段 | 含义 |
| --- | --- |
| `version` | 文件格式版本，当前为 1 |
| `host` / `pid` | 写入进程，用于判断存活 |
| `sessionId` / `sessionFile` | 会话身份与 jsonl 路径，`--no-session` 时为 null |
| `parentSessionFile` | subagent 子会话指向父会话文件 |
| `cwd` / `name` / `mode` / `model` | 展示信息，`name` 来自 `/name` |
| `status` | `idle` 或 `running`，由 `agent_start` / `agent_settled` 切换 |
| `startedAt` / `updatedAt` | 会话开始时间与最近心跳时间 |

写入走同目录临时文件加 rename，权限 0600。会话结束和进程退出时删除文件。

## 失效判定

扩展在每次 `session_start` 时清扫目录：同机条目用 `process.kill(pid, 0)` 判活，进程不在就删除；跨机条目与无法解析的文件按 `updatedAt` 超过 30 分钟删除。读取方可以按 `updatedAt` 超过 60 秒视为失联，不必依赖清扫时机。

心跳写失败只在 `PI_SESSION_HEARTBEAT_DEBUG=1` 时向 stderr 打一行，不打断会话。
