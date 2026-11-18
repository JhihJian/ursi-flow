---
parent: ../SPEC.md
depends-on:
  - ../flow-core/SPEC.md
  - ../sandbox-access/SPEC.md
references:
  - DESIGN.md
  - ../contracts/gateway/v1/README.md
  - ../sandbox-access/ACP.md
  - REAL-RUNTIME-ACP.md
---

# server

## 功能意图

server 是 ursi-flow 的主服务 crate，提供配置加载、业务服务装配、HTTP/SSE、MCP、静态资源和后台生命周期。业务模型、状态机、存储与可替换执行端口由 `flow-core` 拥有；Gateway、Channel 和 Runtime ACP 接入由可选的 `sandbox-access` 提供。

## 模块地图

| 模块 | 职责与规格 |
| --- | --- |
| `src/app` | 配置、依赖组装、启动、后台任务和有序关闭，见 [app SPEC](src/app/SPEC.md) |
| `src/transport` | HTTP、SSE、MCP 传输与静态页面接入，见 [transport SPEC](src/transport/SPEC.md) |
| `src/mcp` | MCP 工具域、运行上下文和后端适配，见 [mcp SPEC](src/mcp/SPEC.md) |
| `flow-core` | 被 server 组装的业务域和持久化边界，见 [core SPEC](../flow-core/SPEC.md) |
| `sandbox-access` | 可选的 Gateway、Channel 和 ACP 接入，见 [接入 SPEC](../sandbox-access/SPEC.md) |

HTTP 与 MCP 经 app 注入的业务服务访问同一份运行和沙箱关联。独立配置、启动与测试见 [Server 使用说明](README.md)。

## 关键功能与验收

### 配置与应用装配

从环境变量构造监听、数据目录、静态资源和可选 Gateway/ACP 配置，初始化 core 存储和服务，再绑定 HTTP 并启动后台扫描。

#### 验收

- 默认可在 `0.0.0.0:8080` 启动，数据目录不存在时创建目录；非法地址、存储失败或 Gateway 配置只设置一项时启动失败。
- 无 Gateway 时应用仍可启动并处理配置、查询和审批类操作；依赖沙箱的执行请求在执行前返回 `sandbox_unavailable`，不伪造成功。
- 关闭时先停止后台和 HTTP 接收，再释放业务服务与存储；监听和后台句柄最终释放。

### 业务协议与事件接入

transport 将请求路由到 core 服务，mcp 将工具域装配到同一状态，事件从持久化记录提供历史读取和实时通知。server 不直接暴露 Gateway 原始响应或密钥。

#### 验收

- HTTP、MCP 和运行收尾共享同一沙箱关联，错误映射保持资源不存在、冲突、Gateway 鉴权/协议错误和不可用的区别。
- 事件订阅、历史重放和断线补读使用持久事件身份，不因广播滞后丢失已提交事件。
- 静态资源缺失不阻止 API 启动，路径回退不吞掉 `/api` 和缺失资源错误。

### 当前远端执行边界

当前生产装配使用 Gateway v1 客户端和 ACP 绑定来准入 Pi 文本执行。脚本执行、文件产物回收和完整 Channel 端点绑定尚未接入 server 的生产装配；相关能力必须由独立替身测试或后续联合验收明确证明。

#### 验收

- Gateway consumer 测试使用 server 生产装配和 HTTP 替身验证受理、实时就绪、释放确认、超时、重启和敏感信息隔离。
- 沙箱未就绪或缺少匹配身份时，启动请求在调度前返回 503，节点尝试次数不增加。已通过准入的运行仍须在执行时核验 Pi 角色和模型。
- 冻结为旧 `runtime-acp` 的运行仍可查询。启动返回迁移冲突，快照和尝试次数保持不变。
- 正式 Runtime 联验需记录当前版本、镜像、bundle、模型来源和会话回收结果。真实 Gateway 生命周期、模型推理和文件产物分别需要相应环境的证据。
