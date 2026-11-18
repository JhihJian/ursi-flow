---
parent: ../SPEC.md
depends-on:
  - ../flow-core/SPEC.md
references:
  - ../contracts/gateway/v1/README.md
  - ../ursi-sandbox/runtime/AGENT-CONTRACT.md
  - ACP.md
---

# sandbox-access

## 功能意图

为 Server 实现 `flow-core` 的沙箱访问端口。Gateway 客户端处理资源控制，数据通道管理连接，Runtime 客户端执行绑定到特定运行的文本任务。本库是平台侧唯一直接使用公共 SDK `ursi-sandbox-client` 的 crate。流程调度归 core，Gateway 和 Runtime 实现独立构建。

## 关键功能与验收

### 资源控制与数据通道

[gateway_v1](src/gateway_v1/SPEC.md) 把 v1 HTTP 报文转换成平台资源状态。[channel](src/channel/SPEC.md) 提供直连与字节隧道、SSH 和 SFTP，`channel_impl` 将通道适配到 core 的 `ChannelGateway`。

#### 验收

- 创建与删除的受理回执保持待确认，调用方能区分就绪、删除确认、冲突、鉴权失败与结果未知。
- 在测试端点上传并读回同一文件，内容一致；连接故障不会触发上层任务重放。

### Runtime 文本执行

`runtime_acp` 使用管理员提供的运行绑定，直连 Runtime 的 `/acp` WebSocket。[session](src/session/SPEC.md) 单独处理调用方注入的帧传输。

#### 验收

- 核对运行关联的沙箱 ID、唯一 internal `session` 端点及绑定文件；缺少匹配身份时不发送 prompt。
- 每次文本调用初始化连接、创建会话、等待 prompt 终态并请求关闭；回执丢失时向 core 报告结果未知，不重新投递。
- 角色模型与绑定不匹配、非空 MCP 等不支持的配置被拒绝。当前 Server 没有装配脚本执行和文件产物回收通道。
