# dae-web 服务端契约

服务端做四件事：托管 `web/dist`、把 `/api/*` 转发到 dae native API（注入 Bearer token）、在 `/console/*` 上编排配置页、按来源限制写操作。dae 的 API 契约属于 dae 本身（`/api/v1`，见 `http://127.0.0.1:9527/api` 的自描述清单），本服务不重写字段。

## 认证

dae 侧启用了 `api.secret`，所有 API 都要求 `Authorization: Bearer <token>`，匿名回环不再生效。token 只保存在服务端，由 `DAE_API_TOKEN` 环境变量提供，systemd 单元用 `EnvironmentFile`（0600）加载。

转发时客户端自带的 `Authorization`、`Origin`、`Referer`、`Cookie` 一律丢弃，只由服务端补上 token。浏览器页面因此不需要、也拿不到 token。token 缺失时服务启动会告警，读接口返回 401。

## 路由

| 路径 | 行为 |
| --- | --- |
| `GET /healthz` | `{ status: 'ok', api, config, console, token }`；`console` 表示当前连接能否读写配置，`token` 表示服务端是否加载到 token |
| `/api/*` | 转发到 `DAE_API_BASE` 的同名路径，保留方法、查询串与请求体，响应状态码与头部原样返回 |
| `/console/config` | `GET` 返回全部配置源、generation、layout 与写权限 |
| `/console/config/check` | `POST { sourcePath, content }`，用 dae 的 `full` 校验该源候选内容 |
| `/console/config/apply` | `POST { sourcePath, content, expectedSha256 }`，校验后 `PUT` 到 dae 并等待操作完成 |
| 其他 | 从 `web/dist` 取静态文件；命中目录或扩展名缺失时回退 `index.html`，缺资源返回 404 |

## 配置写入

配置由 dae 自己写，本服务只编排：

1. `POST /api/v1/config/validate`（`mode: full`，`sources[].path` 为该源相对路径）拿到权威校验结果，未通过不写入。
2. `PUT /api/v1/config/sources/{source_id}`，带 `If-Match: "<content_sha256>"` 与 `Idempotency-Key`。`expectedSha256` 与 dae 当前上报值不一致时直接返回 409，避免覆盖别处改动。
3. dae 接受后返回 202 与 `operation_id`；本服务轮询 `/api/v1/operations/{id}` 到 `succeeded`，返回其中的 `active_generation_id`，超过 20 秒报 504。

dae 只在 managed layout 下允许写配置：`config.dae` 必须只是一个 include 块（引用 `config.d/*.dae` 与 `api.dae`），`config.d/` 必须提供 `global`、`subscription`、`node`、`group`、`routing`、`dns` 六个模块，且每个 section 只来自一个文件。`config.dae` 是入口源，写入被拒（`entry_source`）；`api.dae` 是隐藏源，API 既读不到也写不进，改动需要手动编辑并重启 dae。

dae 每次写入会在同目录生成 `<file>.bak`，这是 dae 自己的备份机制，本服务不再单独维护备份列表。

## 写操作边界

- `GET` / `HEAD` 一律放行。
- `POST /api/v1/routing/trace` 放行：只做规则回放，不改运行状态。
- `/api/v1/config*` 与 `/console/*` 只对回环来源开放：配置里含节点凭据，局域网不返回原文。
- 其余非只读方法（关闭连接、清 DNS 缓存等）只在请求来自回环地址时放行。
- 需要让局域网也能写时显式设置 `DAE_WEB_ALLOW_MUTATIONS=1`，这会把上述限制一并放开，只在可信网络使用。

## 流式响应

`/api/v1/logs` 与 `/api/v1/events` 是 SSE。转发按流处理，不缓冲、不聚合，HTTP 层超时全部关闭（`setTimeout(0)`、`headersTimeout = 0`、`requestTimeout = 0`），否则长连接会被默认 keep-alive 超时截断。客户端断开时中止上游请求。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DAE_WEB_PORT` | `8092` | 监听端口 |
| `DAE_WEB_HOST` | `0.0.0.0` | 监听地址 |
| `DAE_API_BASE` | `http://127.0.0.1:9527` | dae native API 基址 |
| `DAE_API_TOKEN` | 未设置 | dae 的 `api.secret`，通过 `EnvironmentFile` 注入 |
| `DAE_CONFIG_PATH` | `/etc/dae/config.dae` | 配置入口文件，仅用于展示 |
| `DAE_WEB_STATIC_DIR` | 相对 `server/` 的 `../web/dist` | 静态产物目录 |
| `DAE_WEB_ALLOW_MUTATIONS` | 未设置 | 设为 `1` 时允许非回环来源执行写操作与看配置 |

## 已知限制

- dae 的连接与流记录只在进程内存中，重启即丢；本服务不做落盘采集。
- dae 在流记录里把 `rule_id` 记为 null、`rule_source` 记为 `unknown`，页面用路由回溯补齐命中规则。
- dae API 目前标记为 draft，字段以 `/api/v1/capabilities` 与实测返回为准，本服务不额外校验。
- 只编辑 `config.d/*.dae`；入口文件与 `api.dae` 需要手动改并重启 dae。
