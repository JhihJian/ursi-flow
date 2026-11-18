---
parent: ../../SPEC.md
depends-on:
  - ../flow/SPEC.md
references:
  - ../work/items/HTTP.md
  - ../work/execute/API.md
  - ../work/sources/README.md
---

# HTTP 接入

## 功能意图

`transport` 在 `/api` 下统一鉴权，组合工作管理路由和可选的 Flow 管理路由。v1 通过 FlowService 访问 Runtime，v2 的请求与响应由各工作模块定义。Server 不提供静态页面。

## 关键功能与验收

### `/api/v1` 接口

#### 验收

仅在启用 Flow 时挂载。以下路径均相对于 `/api/v1`。成功响应的 JSON 是 Runtime 的结果，不增加外层字段。

| 方法与路径 | 请求或返回约定 |
| --- | --- |
| `GET /flows` | 返回 Flow ID 的字符串数组 |
| `POST /flows`、`POST /flows/validate` | `{id, files}`，其中 files 是文件名到文本的对象 |
| `GET /flows/{id}`、`DELETE /flows/{id}` | 查询、删除指定包 |
| `PUT /flows/{id}` | `{files, expectedRevision?}`，可按修订更新 |
| `POST /flows/{id}/runs` | `{runId?, workspace: "default", variables}`，variables 为 JSON 对象；拒绝传入目录路径 |
| `GET /runs`、`GET /runs/{id}`、`GET /runs/{id}/history` | 查询运行列表、单个运行及其历史 |
| `POST /runs/{id}/stop` | 停止运行 |
| `GET /flow-config`、`PATCH /flow-config` | 查询配置，或提交配置字段对象 |

### `/api/v2` 接口

#### 验收

以下路径均相对于 `/api/v2`。`{collection}` 为 `resources`、`executors` 或 `packages`。关闭 Flow 时工作管理路由仍可用，Flow 动作不可执行。

| 方法与路径 | 用途 |
| --- | --- |
| `GET /{collection}`、`POST /{collection}` | 列出最新定义、发布新版本，见[定义目录](../work/catalog/SPEC.md) |
| `GET /{collection}/{id}`、`GET /{collection}/{id}/revisions`、`GET /{collection}/{id}/revisions/{revision}` | 查最新版、版本列表或冻结版本 |
| `POST /{collection}/{id}/deactivate` | 停用定义，保留历史 |
| `POST /items`、`GET /items`、`GET /items/{id}` | 按包版本派工、按状态列单、查单，见[工作项契约](../work/items/HTTP.md) |
| `POST /items/{id}/start`、`POST /items/{id}/deliveries` | 开始办理、提交一版交付文本 |
| `GET /items/{id}/deliveries/{version}/files/{name}`、`POST /items/{id}/deliveries/{version}/review` | 读取该版交付文本、通过或退回本版 |
| `POST /items/{id}/attempts`、`GET /items/{id}/attempts`、`GET /items/{id}/attempts/{attempt}` | 发起、列出或查询尝试，见[执行契约](../work/execute/API.md) |
| `POST /items/{id}/attempts/{attempt}/cancel`、`POST /items/{id}/attempts/{attempt}/verify` | 取消单次执行、人工核实待确认的 Agent 尝试 |
| `GET /sources`、`GET /sources/{provider}/items`、`GET /sources/{provider}/items/{id}` | 列出已配置的 JSON 文件来源、查询导出材料，见[来源契约](../work/sources/README.md) |
| `POST /sources/{provider}/items/{id}/dispatch` | 按来源的固定动作派工，不启动尝试 |

未设置 `URSI_WORK_SOURCES` 时，已认证的来源请求返回 404。交付文件按工作项、版本和文件名读取；没有通用文件管理、PTY 或浏览器路由。

### 认证与错误

#### 验收

- `/api` 及其子路径在调用用例前校验 Authorization。缺少凭证、凭证不符或多个 Authorization 头返回 401 并带 `WWW-Authenticate: Bearer`。空配置 token 无法授权。
- 请求体不符合接口返回 4xx。v1 SDK 报告参数非法、业务未找到、冲突、运行并发已满时，分别返回 400、404、409、429。
- v1 的 Runtime 连接不可用返回 503，响应协议错误返回 502，超时返回 504。错误响应不回显底层路径、凭证或异常文本。

### 非 API 路径

#### 验收

- 根路径、前端深链和静态资源路径返回 404。`/api` 与 `/api/*` 始终留在受鉴权的 API 路由，授权后的未知路径返回 404。
