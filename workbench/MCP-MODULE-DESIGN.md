# 平台 MCP 独立模块设计

[`ursi-mcp/`](../ursi-mcp/README.md) 包含 Rust 库和可嵌入的 React 包。Workbench Server 和 Web 分别引用这两个包，沿用当前进程、同源 API 和登录会话。其他宿主可独立构建两个包，登记服务并浏览资源。

## 边界

| 能力 | 归属 | 原因 |
| --- | --- | --- |
| 登记和设置、出站策略判定、HTTP 会话、资源和模板发现、工具调用、提示词、资源预览 | `ursi-mcp/server` | 登记和调用必须执行同一套地址、凭据与工具授权规则。Rust 库对外提供操作接口和可挂载的 Axum 路由。 |
| 服务列表、服务详情、工具授权与调用确认、预览、类型化 API 客户端 | `ursi-mcp/web` | 管理页面和其他业务页面都可以通过同一份客户端访问 MCP。 |
| 请求鉴权、记录落盘、平台变量管理、部署策略文件位置、导航 | Workbench 宿主 | 继续复用宿主的信任边界、存储锁和管理入口。模块只获取完成操作需要的数据。 |
| 工作项配方、Python 隔离转换、路径校验、来源与幂等发布 | Workbench 工作清单与包模块 | MCP 返回资源内容，工作清单决定用哪些材料、如何生成和登记文件包。 |
| 本机 stdio 执行器、配置包中的 `mcp.json`、资源定义中的 MCP 引用 | 各自现有模块 | 前者实现[执行器生命周期](../docs/EXECUTOR-MCP.md)，后两者属于配置和版本化定义。 |

## Workbench 如何引用

**Server。** 创建一个共享的 `McpPlatform`，向它提供服务记录仓储、按名称读取最新凭据的接口和部署策略位置。仓储只暴露 MCP 记录的查询、增删和原子设置更新；Workbench 适配器继续操作 `work.json` 中的 `mcpServers`，保留 ID、锁和持久化格式。新库拥有 MCP 类型和安全错误，不接收整份 `Store` 或 Workbench 的 `Error`。把库的相对 `/mcp-servers` 路由挂在已认证的 `/api/v2` 下，保持[现有 API 契约](server/src/work/mcp/PLATFORM.md)。

**Web。** 包导出 `createMcpClient(request)` 和 MCP 管理页路由工厂。Workbench 注入已有的 `requestV2`、平台变量名称列表和管理页链接，注册 `/mcp-servers` 与 `/mcp-servers/:id`。`/platform-env` 及变量增删改留在宿主，浏览器的 MCP 接口只接触变量名。配方编辑器直接调用同一客户端的 `listServers`、`listResources`。React 与 Router 作为 peer 依赖，包内页面只引用本包或显式依赖的 UI 与样式，不通过别名读取 Workbench 的 `@/shared`。

**生成工作包。** [工作清单转换器](server/src/work/worklist/convert.rs)持有一次生成的操作名额，通过 `Operation::read_resource` 逐项重读材料，再计算快照摘要、执行沙箱和校验路径。工作清单随后幂等发布。名额覆盖整次转换，每次资源读取复用该名额。页面预览与生成使用同一个模块实例，生成独立读取材料。

## 迁移与验收

1. **先抽协议和授权。** 将 Streamable HTTP、会话和目录客户端与宿主类型解耦，再把登记、操作规则和路由迁入同一 crate。用内存仓储与模拟端点测试 `server/discover`、旧式 `initialize`、JSON/SSE 分页及读取。保持每响应 4 MiB、禁止重定向和请求重放、错误脱敏。新会话重读策略和凭据，只有文件策略绑定可回退到进程变量；工具握手期间撤销白名单后不得发出 `tools/call`。
2. **接入后端和工作清单。** 通过原 v2 路由验证认证、已登记 ID 和设置仍可用。发现、预览、工具及转换共用 4 个并发名额；操作超时和转换 45 秒总时限保持现状。用已有配方验证来源摘要、重复生成请求只发布一个包、读取失败不执行脚本也不发布。
3. **抽管理页面并切换引用。** 单独构建 Web 包，用一个最小宿主挂载路由。再在 Workbench 验证登记、深链预览、确认后调用工具、凭据删除后的失败提示，以及配方选择资源。最终由依赖检查确认两个包均不导入 Workbench 私有代码。

通用行为见[后端规格](../ursi-mcp/server/SPEC.md)与[前端规格](../ursi-mcp/web/SPEC.md)。Workbench 的宿主职责见[后端接入规格](server/src/work/mcp/SPEC.md)、[页面接入规格](web/src/modules/mcp/SPEC.md)与[配方转换契约](server/src/work/worklist/CONVERSION.md)。
