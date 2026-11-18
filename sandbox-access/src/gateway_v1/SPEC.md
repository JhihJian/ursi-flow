---
parent: ../../SPEC.md
depends-on:
  - ../../../flow-core/src/sandboxes/SPEC.md
references:
  - ../../../contracts/gateway/v1/README.md
  - ../../../ursi-sandbox/gateway/CONTRACT.md
---

# gateway_v1

## 功能意图

`gateway_v1` 是 server 到 Gateway v1 的协议防腐层。它负责 URL、鉴权、请求路径、wire DTO、响应校验和错误分类，把 Gateway 的异步资源语义转换为 `flow-core` 的 GatewayClient 端口。

## 关键功能与验收

### 资源控制请求

实现沙箱准备、状态查询和释放请求。准备和释放都先返回受理语义，业务层继续使用资源标识查询就绪或删除确认。

#### 验收

- 创建请求包含冻结规格和非空幂等键，重复调用可复用 Gateway 返回的资源标识。
- HTTP 202 被映射为受理或释放待确认，不报告资源已就绪或已删除；契约规定的 `404/not_found` 才能作为删除确认。
- 成功回执缺必需字段、成功状态码不符或 404 未带 `not_found` 错误码时，返回协议错误。

### 身份与敏感信息隔离

客户端拒绝带用户信息、query、fragment 或非法 scheme 的基地址，Bearer key 只保存在客户端内部，向 server 上层只暴露稳定错误类别。

#### 验收

- 无效 URL、非法资源标识和错误身份在请求前或响应后得到明确错误。
- 客户端 Debug 不展示 key；Server 在向业务层保存或返回错误前，只转交错误分类及固定摘要。
- 测试可以通过 HTTP 替身验证真实请求路径、方法、头部、幂等键和 JSON body。
