# dae-web 服务端契约

服务端只有三件事：托管 `web/dist`、把 `/api/*` 原样转发到 dae native API、按来源限制写操作。dae 的 API 契约属于 dae 本身（`/api/v1`，见 `http://127.0.0.1:9527/api` 的自描述清单），本服务不重写字段。

## 路由

| 路径 | 行为 |
| --- | --- |
| `GET /healthz` | `{ status: 'ok', api: '<DAE_API_BASE>' }` |
| `/api/*` | 转发到 `DAE_API_BASE` 的同名路径，保留方法、查询串与请求体，响应状态码与头部原样返回 |
| 其他 | 从 `web/dist` 取静态文件；命中目录或扩展名缺失时回退 `index.html`，缺资源返回 404 |

转发会去掉浏览器的 `origin`、`referer`、`cookie` 头并把 `Host` 改为 dae 地址：dae 拒绝外部 Origin 的请求，而浏览器页面与服务端同源，因此由服务端以本机身份访问。

## 流式响应

`/api/v1/logs` 与 `/api/v1/events` 是 SSE。转发按流处理，不缓冲、不聚合，HTTP 层超时全部关闭（`setTimeout(0)`、`headersTimeout = 0`、`requestTimeout = 0`），否则长连接会被默认 keep-alive 超时截断。客户端断开时中止上游请求。

## 写操作边界

- `GET` / `HEAD` 一律放行。
- `POST /api/v1/routing/trace` 放行：只做规则回放，不改运行状态。
- 其余非只读方法（`DELETE /api/v1/connections/{id}`、`POST /api/v1/dns/cache/flush`、`DELETE /api/v1/dns/cache/{id}` 等）只在请求来自回环地址时放行；来自局域网的写请求返回 `403 { error: { code: 'read_only' } }`。
- 需要让局域网也能写时显式设置 `DAE_WEB_ALLOW_MUTATIONS=1`。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DAE_WEB_PORT` | `8092` | 监听端口 |
| `DAE_WEB_HOST` | `0.0.0.0` | 监听地址 |
| `DAE_API_BASE` | `http://127.0.0.1:9527` | dae native API 基址 |
| `DAE_WEB_STATIC_DIR` | 相对 `server/` 的 `../web/dist` | 静态产物目录 |
| `DAE_WEB_ALLOW_MUTATIONS` | 未设置 | 设为 `1` 时允许非回环来源执行写操作 |

## 已知限制

- dae 的连接与流记录只在进程内存中，重启即丢；本服务不做落盘采集。
- dae 在流记录里把 `rule_id` 记为 null、`rule_source` 记为 `unknown`，页面用路由回溯补齐命中规则。
- dae API 目前标记为 draft，字段以 `/api/v1/capabilities` 与实测返回为准，本服务不额外校验。
