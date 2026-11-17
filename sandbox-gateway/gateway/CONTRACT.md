# Gateway HTTP 与传输契约

## 身份与响应

除 `GET /healthz` 外，所有资源接口要求 `Authorization: Bearer <key>`。独立进程启动时拒绝未配置或不足 16 字节的 key。该身份拥有本 Gateway 命名空间的管理权限，不提供多租户身份体系。

错误为 `{ "error": { "code": "...", "message": "..." } }`。缺失/错误身份返回 401，参数非法 400，资源不存在 404，操作冲突 409，能力不支持 501，资源暂不可用 503，内部存储错误 500。隧道目标 TCP 拨号失败在升级前返回 502。响应不返回驱动原始错误，沙箱错误状态只给安全摘要，诊断详情保存在受控数据库中。

## 控制面路由

| 方法与路径 | 请求 | 响应 |
|---|---|---|
| `GET /healthz` | 无 | 200，HTTP 进程健康，不代表所有沙箱就绪 |
| `GET /api/v1/capabilities` | 无 | 200，driver、capabilities、tunnel_enabled |
| `POST /api/v1/sandboxes` | SandboxSpec，可选 `Idempotency-Key` | 202，Sandbox |
| `GET /api/v1/sandboxes` | 无 | 200，`{sandboxes:[...]}` |
| `GET /api/v1/sandboxes/{id}` | 无 | 200，Sandbox |
| `POST /api/v1/sandboxes/{id}/start` | 无 | 202，Sandbox |
| `POST /api/v1/sandboxes/{id}/stop` | 无 | 202，Sandbox |
| `POST /api/v1/sandboxes/{id}/rebuild` | `{preserve_data:true或false}`，必须显式选择 | 202，Sandbox |
| `DELETE /api/v1/sandboxes/{id}` | 无 | 202，带删除意图的 Sandbox，完成后查询 404 |
| `GET /api/v1/sandboxes/{id}/logs?tail=5000` | tail 范围 1..5000 | 200，`{content:"..."}`，有输出大小上限 |
| `GET /api/v1/sandboxes/{id}/endpoints` | 无 | 200，`{endpoints:[...]}` |

所有规格结构拒绝未知字段。同一创建幂等键绑定同一规格与沙箱，删除后保留 key 绑定。生命周期请求先落库再返回受理，驱动操作由后台调度。对账与请求采用每沙箱互斥，忙碌或冲突时返回 409。

## SandboxSpec

```json
{
  "image": "ursi-gateway-acceptance:local",
  "command": [],
  "ports": [
    {"name": "web", "port": 8080, "visibility": "public", "ready": true},
    {"name": "echo", "port": 9001, "visibility": "internal", "ready": true}
  ],
  "labels": {},
  "memory_mb": 256,
  "cpus": 1.0,
  "bundle": null
}
```

`image` 必填，其他字段具有上述默认值（ports 默认空）。端点名/端口不得重复，端口范围 1..65535，最多 32 个端点。内存 16..65536 MiB，CPU 大于 0 且不超过 128。command 为空使用镜像默认命令。

bundle 可为 `{url, sha256, min_image_level}`：无凭据 HTTP(S) URL、64 位十六进制校验值及最低镜像级别。Docker 镜像必须声明 `io.ursi.image-level` 并满足要求。引用透传为 `URSI_BUNDLE_URL`、`URSI_BUNDLE_SHA256`、`URSI_BUNDLE_MIN_IMAGE_LEVEL`，bootstrap 负责下载、校验和装配。当前不提供通用 env、宿主挂载、密钥存储或模板 API。

## Sandbox 与操作意图

Sandbox 包含 `id`、冻结 `spec`、`resource:{generation,data_generation}`、`retired`、`revision`、`status`、`operation`、`endpoints` 和 `error`。status 为 `preparing/running/stopped/deleting/error`。operation 为 null 或带 `kind` 的 `create/start/stop/delete/rebuild`，重建额外记录 `previous` 与 `preserve_data`。

每个资源操作先持久化，修订号 CAS 防止过期写入。一次重建递增工作负载代际，销毁数据重建另选新数据代际。旧资源保存在 retired，重试只清理明确记录的旧代资源；保数据重建旧卷缺失时失败，不新建空卷冒充成功。删除期间先清理所有已知代际容器，再清理卷，失败保留意图并重试。

一份数据库由一个进程独占，绑定驱动、namespace 与 Docker daemon 身份。调度任务异常或元数据列表无法读取时，Gateway 停止受理新操作并非零退出。正常终止对 HTTP 连接提供最多 3 秒宽限，已持久化操作由重启继续。启动和周期对账接回创建后未回填的资源，观察到运行状态不能覆盖待删除意图。查询超时保持记录；正常资源被外部删除时保留错误记录，管理员可重建或删除。fake 仅提供进程内测试资源，不能代替真实恢复验收。

## 端点与就绪

Endpoint 为 `{name,port,visibility,address}`，地址由实时 Docker 查询生成。public 映射宿主临时端口，internal 返回受控容器网络地址。CDP/noVNC 名称及 9222/6080 端口强制 internal。没有临时公开 internal 端口的 API。

命名数据卷挂载 `/ursi/workspace`，驱动只处理具有匹配 scope、id 与代际标签的资源。真实 Docker 驱动固定本地 Unix socket，首版不支持远程 daemon。

准备完成需要容器运行、已配置 Docker HEALTHCHECK 通过，以及 `ready:true` 的端点可连接。健康检查应验证镜像声明的真实服务功能，TCP 可达本身只证明端口监听。端点查询返回上次对账快照，隧道建立前重新读取实际资源状态与地址。

## 可选 TCP over WebSocket

`GET /api/v1/sandboxes/{id}/connect/{endpoint}`，子协议为 `ursi-tcp-v1`。这是本项目协议，帧行为参考 Grasp，未声明整个 Grasp API 兼容。端点参数为已声明端点名，不接受任意 host/URL。隧道关闭时返回 501。

升级前完成 Bearer 鉴权、子协议、目标身份和可达性校验。请求携带 Origin 或任何 query 被拒绝。直连和隧道使用相同 SSH/ACP/HTTP 等上层协议，Gateway 不解析这些业务内容。

- 二进制消息承载有序 TCP 字节，客户端每消息最多 64 KiB，Gateway 输出每块最多 32 KiB。
- 文本 `eof` 表示该方向半关闭，另一方向继续传输尾包。重复 EOF、EOF 后继续数据、其他文本均关闭连接。
- Ping/Pong 保活；空闲 75 秒、写入停滞 30 秒可终止。中间队列有界，背压不会阻止生命周期取消。
- 停止、删除、重建、Gateway 停机或连接取消后，回收两侧连接。隧道自身不重试 prompt 或执行命令。

参考路径和测试证据见 [独立验收](ACCEPTANCE.md)，Runtime 的服务装配边界见 [Runtime 契约](../runtime/CONTRACT.md)。
