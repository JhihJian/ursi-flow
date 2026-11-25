# dae-web 服务端契约

服务端做四件事：托管 `web/dist`、把 `/api/*` 原样转发到 dae native API、在 `/console/*` 上编排配置文件读写、按来源限制写操作。dae 的 API 契约属于 dae 本身（`/api/v1`，见 `http://127.0.0.1:9527/api` 的自描述清单），本服务不重写字段。

## 路由

| 路径 | 行为 |
| --- | --- |
| `GET /healthz` | `{ status: 'ok', api, config, console }`；`console` 表示当前连接能否读写配置文件 |
| `/api/*` | 转发到 `DAE_API_BASE` 的同名路径，保留方法、查询串与请求体，响应状态码与头部原样返回 |
| `/console/config` | `GET` 返回配置文件内容、sha256、写权限与备份清单 |
| `/console/config/check` | `POST { content }`，用 dae 的 `full` 校验候选内容 |
| `/console/config/apply` | `POST { content, expectedSha256 }`，校验 → 备份 → 写文件 → 热加载 |
| `/console/config/restore` | `POST { backup }`，校验备份内容 → 备份当前文件 → 写文件 → 热加载 |
| 其他 | 从 `web/dist` 取静态文件；命中目录或扩展名缺失时回退 `index.html`，缺资源返回 404 |

转发会去掉浏览器的 `origin`、`referer`、`cookie` 头并把 `Host` 改为 dae 地址：dae 拒绝外部 Origin 的请求，而浏览器页面与服务端同源，因此由服务端以本机身份访问。

## 流式响应

`/api/v1/logs` 与 `/api/v1/events` 是 SSE。转发按流处理，不缓冲、不聚合，HTTP 层超时全部关闭（`setTimeout(0)`、`headersTimeout = 0`、`requestTimeout = 0`），否则长连接会被默认 keep-alive 超时截断。客户端断开时中止上游请求。

## 配置写入

dae 自带的配置写入要求同时开启 `api.config_write` 与 `api.secret`（`config/api.go` 的校验规则），设了 secret 后匿名回环失效，整个 API 都要 Bearer token。本服务不这么做，改为自己编排：

1. `POST /api/v1/config/validate`（`mode: full`）让 dae 校验候选内容，未通过不落盘。
2. 把当前文件内容写入备份目录（`$XDG_STATE_HOME/dae-web/backups`，回退 `~/.local/state`），保留最近 20 份。
3. `sudo -n tee <DAE_CONFIG_PATH>` 写入，保留 root:root 0640；因此运行用户需要该文件的免密 sudo 权限。
4. `POST /api/v1/operations/reload` 后轮询操作到 `succeeded`，超时 20 秒；失败则写回备份并再加载一次。

`sources[].path` 取自 `GET /api/v1/config`（通常为 `config.dae`），校验请求必须用它。`GET /api/v1/config` 报告 `secrets_redacted` 为真时禁止保存，否则会把掩码写回文件。保存请求带 `expectedSha256`，与 dae 当前上报的 `content_sha256` 不一致时返回冲突，避免覆盖别处的改动。

## 写操作边界

- `GET` / `HEAD` 一律放行。
- `POST /api/v1/routing/trace` 放行：只做规则回放，不改运行状态。
- 其余非只读方法（`DELETE /api/v1/connections/{id}`、`POST /api/v1/dns/cache/flush`、`DELETE /api/v1/dns/cache/{id}` 等）只在请求来自回环地址时放行；来自局域网的写请求返回 `403 { error: { code: 'read_only' } }`。
- 整个 `/console/*`（配置的读与写）只对回环来源开放，与上面的写操作边界独立判断。
- 需要让局域网也能写时显式设置 `DAE_WEB_ALLOW_MUTATIONS=1`，这会把 `/console/*` 一并放开，配置内容（可能含节点凭据）随之外泄，只在可信网络使用。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DAE_WEB_PORT` | `8092` | 监听端口 |
| `DAE_WEB_HOST` | `0.0.0.0` | 监听地址 |
| `DAE_API_BASE` | `http://127.0.0.1:9527` | dae native API 基址 |
| `DAE_CONFIG_PATH` | `/etc/dae/config.dae` | 配置页写入的本机文件 |
| `DAE_WEB_STATIC_DIR` | 相对 `server/` 的 `../web/dist` | 静态产物目录 |
| `DAE_WEB_ALLOW_MUTATIONS` | 未设置 | 设为 `1` 时允许非回环来源执行写操作 |

## 已知限制

- dae 的连接与流记录只在进程内存中，重启即丢；本服务不做落盘采集。
- dae 在流记录里把 `rule_id` 记为 null、`rule_source` 记为 `unknown`，页面用路由回溯补齐命中规则。
- dae API 目前标记为 draft，字段以 `/api/v1/capabilities` 与实测返回为准，本服务不额外校验。
- 配置写入依赖本机 sudo 免密与 dae 的 `operations/reload`；dae 未运行时保存会在校验步骤直接失败。
- 只编辑主配置源（`kind: main`），不处理 `include` 引入的其它文件。
