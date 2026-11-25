---
parent: ../../SPEC.md
depends-on:
  - ../../../../flow-host/client/SPEC.md
---

# Flow 用例

## 功能意图

向 HTTP 层提供异步的 Flow 包管理、运行控制与配置用例。`FlowService` 只通过异步 `FlowClient` 适配器访问 Runtime。用例层负责解析工作区与生成缺省运行 ID，适配器负责调用同步 SDK。包校验、修订比较、运行状态和历史均由 Runtime 管理。

## 关键功能与验收

### 包、运行与配置

#### 验收

- 包的查询、创建、校验、更新和删除保留 SDK 的 JSON 结果。更新时将可选的预期修订随同文件交给 SDK，由 Runtime 比较并写入。
- 启动运行只接受 `default` 工作区别名。其他值在 SDK 调用前被拒绝。SDK 收到配置目录、原始变量和调用方的运行 ID。省略 ID 时服务生成 UUID。可选的 `executorRef: {id, revision}` 原样传给 Runtime，用于本次运行的 Agent 节点；显式空值与无效修订拒绝启动。
- 运行列表、详情、历史、停止及配置查询和修改返回 Runtime 原始 JSON，SDK 错误保留 `io::ErrorKind`。

### 阻塞调用隔离

#### 验收

- 适配器是唯一的调用限流边界。使用同一适配器或其克隆的所有用例共享 8 个调用名额。取得名额后才向阻塞线程池提交 SDK 调用，等待者不占用阻塞线程。
- HTTP 请求取消后，已经提交的同步调用在结束时释放名额。其他请求遵守同一上限。
