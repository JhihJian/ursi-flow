# ursi-mcp

`ursi-mcp` 管理已登记的 Streamable HTTP MCP 服务。可以运行独立管理台，也可以把后端库与管理页面嵌入其他应用。

## 独立交付

在 Linux x86_64 或 ARM64 构建机上，安装 Node.js 24、Rust 和本机 `musl-gcc`，并安装对应 Rust 目标 `x86_64-unknown-linux-musl` 或 `aarch64-unknown-linux-musl`。从仓库根目录运行：

```sh
bash ursi-mcp/scripts/package.sh
```

压缩包和 SHA-256 文件生成在 `ursi-mcp/dist/`。解压后按[启动说明](app/DEPLOY.md)启动。运行机器无需 Workbench、Flow 或构建工具。构建机可运行 `python3 ursi-mcp/scripts/smoke.py <解压目录>/ursi-mcpd`，检查独立启动、资源读取和重启持久化。

## 嵌入应用

宿主负责认证、持久化和平台变量管理，模块负责登记规则、出站授权、会话及限额。

## Rust 宿主

通过 Cargo 路径依赖引入 [`ursi-mcp`](server/Cargo.toml)。实现 `ServerRepository` 与 `Credentials`，并将策略文件路径和 MCP 客户端标识传给 `McpPlatform::new`。登记仓储须原子执行数量限制，设置更新只修改仍存在的记录。将 `platform.routes()` 挂到宿主已认证的路由下，见 [HTTP 契约](server/HTTP.md)。同一宿主应共享一个实例，克隆实例仍共用四个操作名额。

批量读取使用 `platform.operation()` 获取名额，通过返回值的 `read_resource` 逐项读取。宿主为批量操作设置总时限。登记不会发起出站连接，工具调用需要精确白名单，部署策略可进一步收紧许可。

## React 宿主

在 `ursi-mcp/web` 下运行 `npm ci`、`npm run build`、`npm pack`，再将生成的包安装到宿主应用。React、React DOM 和 React Router 由宿主提供。构建产物自带页面样式。

```tsx
import { createMcpClient, createMcpRoutes } from '@ursi/mcp-web'

const client = createMcpClient(requestV2)
const routes = createMcpRoutes({
  client,
  listVariableNames: signal => requestV2<string[]>('/platform-env', { signal }),
  variableManagementPath: '/platform-env',
})
```

`requestV2` 由宿主提供，解析 JSON、处理失败并附带认证。路由工厂返回相对路由，可直接追加到已登录的页面树。宿主提供变量名称列表与管理页地址，变量值不进入 MCP 管理页。

## 验证

在仓库根目录运行：

```sh
cargo test --locked --manifest-path ursi-mcp/server/Cargo.toml
npm --prefix ursi-mcp/web test
```
