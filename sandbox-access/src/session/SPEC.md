---
parent: ../../SPEC.md
depends-on:
  - ../../../flow-core/src/agent_runtime/SPEC.md
  - ../../../flow-core/src/domain/SPEC.md
references:
  - ../../ACP.md
  - ../../../ursi-sandbox/runtime/AGENT-CONTRACT.md
---

# session

## 功能意图

`session` 在调用方注入的帧传输上实现会话请求、响应关联和遥测转换。它可以单独用内存对端验证；Server 直连正式 Runtime 的鉴权、初始化和停止回执核实由同 crate 的 `runtime_acp` 处理。

## 关键功能与验收

### 会话生命周期

通过 ACP 帧传输创建会话、提交文本 prompt、取消和关闭请求，保存本地会话与远端 sessionId 的关联，并区分已完成、已取消和结果未知。

#### 验收

- run、node、session 关联标识贯穿创建、prompt、事件、取消和关闭请求。
- session-service 明确返回取消或完成时映射为可判断状态，连接中断返回结果未知且不自动重放。
- 同一会话的请求响应按 JSON-RPC ID 关联，陈旧响应或其他会话事件不能改变当前结果。

### 事件与错误映射

将 ACP 文本、工具和未知通知映射为 core 观测事件，保留会话归属；将协议错误、任务失败、能力不支持和连接断开映射为不同错误。

#### 验收

- 事件顺序、会话归属和 run/node 关联保持一致，缺少观测消费者不阻塞控制请求。
- 匹配的响应含 JSON-RPC error 时返回任务错误；传输结束但缺少匹配响应时返回连接中断。
