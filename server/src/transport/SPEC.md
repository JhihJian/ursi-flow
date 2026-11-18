---
parent: ../../SPEC.md
depends-on:
  - ../flow/SPEC.md
---

# HTTP 接入

## 功能意图

以 Bearer token 保护 Flow 管理 API，并从可选目录提供同源静态页面。HTTP 负责解析请求与映射错误，业务操作交给 FlowService。

## 关键功能与验收

### `/api/v1` 接口

#### 验收

以下路径均相对于 `/api/v1`。成功响应的 JSON 是 Runtime 的结果，不增加外层字段。

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

### 认证与错误

#### 验收

- `/api` 及其子路径在调用用例前校验 Authorization。缺少凭证、凭证不符或多个 Authorization 头返回 401 并带 `WWW-Authenticate: Bearer`。空配置 token 无法授权。
- 请求体不符合接口返回 4xx。SDK 报告参数非法、业务未找到、冲突、运行并发已满时，分别返回 400、404、409、429。
- Runtime 连接不可用返回 503，响应协议错误返回 502，超时返回 504。错误响应不回显底层路径、凭证或异常文本。

### 静态页面与深链

#### 验收

- 无需凭证即可 GET/HEAD 静态资源。无构建产物、静态目录未配置或带扩展名的资源缺失时返回 404。
- 无扩展名的前端导航路径回退 `index.html`；`/api` 与 `/api/*` 始终留在 API 路由，授权后的未知路径返回 404。
- 拒绝路径穿越、反斜杠和常见编码穿越变体。命中的文件和回退入口都必须解析到配置的静态根目录内。
