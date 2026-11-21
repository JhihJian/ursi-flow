---
parent: ../../SPEC.md
references:
  - ../../../../docs/design/workbench/WEB-SHELL-AND-FLOW.md
---
# Web 共享层

## 功能意图

统一访问工作管理与 Flow HTTP 服务，并提供各页共享的异步读取、界面控件和反馈。

## 关键功能与验收

### 同源业务请求

#### 验收

- `requestJson<T>` 读取 `/api/v1`，`requestV2<T>` 读取 `/api/v2`，均直接返回业务 JSON；`204` 返回无内容。
- `requestV2File` 按 `application/octet-stream` 读取目录文件，保留原始字节，允许空文件。
- 三种请求使用同源相对路径，保留请求方法、正文与 AbortSignal。仅通过 Bearer 请求头发送会话令牌，拒绝无令牌请求和绝对地址。
- 错误保留 HTTP 状态并从消息中隐藏令牌。仅当前令牌的 401 清除会话；其他错误或旧会话的迟到响应不影响新登录。浏览器地址和 localStorage 均不记录令牌。
- 资源重新加载时旧响应不能覆盖新数据，组件卸载取消读取。
- Agent 后端客户端通过 `GET /api/v2/agent-backends` 读取公开的 `id`、`label`、`capabilities`、`configured`、`status`、`checkedAt`（毫秒时间戳或 null）；带 `configPackageId` 的查询额外返回 `compatible`。`POST /api/v2/agent-backends/{id}/check` 返回单个后端的最新公开状态。

### 共享呈现

#### 验收

- 加载、错误、空结果有不同的呈现；操作可要求确认。
- 对话 Markdown 经过净化，模态框关闭后恢复焦点，控件复用主题色。
- `copyText` 在安全上下文走异步剪贴板，否则用临时只读文本域选中后复制，两种方式都失败时返回 `false` 交由调用方提示手动复制，且不残留额外节点。
