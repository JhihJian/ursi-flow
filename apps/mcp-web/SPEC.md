---
parent: ../../SPEC.md
references:
  - README.md
  - ../../docs/design/mcp-web/RECOGNITION-RULES.md
---

# mcp-web

## 功能意图

提供 Streamable HTTP MCP 服务管理。管理员可使用独立管理台，其他应用也可嵌入后端库和管理页面。

## 关键功能与验收

### 独立交付

#### 验收

- 从 `mcp-web` 构建平台对应的压缩包。解压后，Linux 主机无需其他服务或前端运行时即可启动[独立管理台](app/SPEC.md)。
- 用户可凭独立管理令牌登录、登记已授权的端点并预览资源。重启后保留服务登记与凭据引用，凭据值由部署方提供。

### 嵌入式 MCP 服务管理

#### 验收

- [后端库](server/SPEC.md)与[前端包](web/SPEC.md)可独立于其他服务构建和测试。
- 宿主提供已认证的 API、服务仓储与凭据入口后，可在界面登记服务、预览资源并确认调用已授权的工具。登记与浏览无需额外部署进程。
