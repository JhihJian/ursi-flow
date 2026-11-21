---
parent: ../../../SPEC.md
depends-on:
  - ../../../../../ursi-mcp/server/SPEC.md
references:
  - PLATFORM.md
---

# 平台 MCP 宿主接入

## 功能意图

Workbench 将平台 MCP 挂在已认证的管理 API 下，为同一个模块实例提供记录仓储、凭据查找和策略文件位置。

## 关键功能与验收

### 服务登记与凭据

#### 验收

- 原 `/api/v2/mcp-servers` 与 `/api/v2/platform-env` 接口保持可用。服务记录继续保存在 `work.json` 的 `mcpServers`，原登记 ID 和设置可直接读写，协议检查结果随登记保留，更新结果不覆盖设置。
- 平台变量只公开名称。新会话使用最新值，页面登记引用的变量删除后拒绝连接。部署文件仍为 `work/mcp-policy.json`，只允许文件策略模式使用宿主环境变量。
- 工作包生成和 HTTP 管理 API 共享同一个模块实例及操作名额。
