---
parent: ../SPEC.md
references:
  - README.md
  - ../workbench/MCP-MODULE-DESIGN.md
---

# ursi-mcp

## 功能意图

为需要管理和访问 Streamable HTTP MCP 服务的应用提供可独立引用的后端库和管理界面。宿主管理登录、记录持久化、变量和业务流程。

## 关键功能与验收

### 嵌入式 MCP 服务管理

#### 验收

- [后端库](server/SPEC.md)与[前端包](web/SPEC.md)可独立于 Workbench 与 Flow 构建和测试。
- 宿主提供已认证的 API、服务仓储与凭据入口后，可在界面登记服务、预览资源并确认调用已授权的工具。登记与浏览无需额外部署进程。
