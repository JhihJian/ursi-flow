# 启动独立 MCP 管理台

交付包包含 Linux 可执行文件 `ursi-mcpd` 和同目录的 `web/` 管理页面。保留二者的相对位置，即可从任意工作目录启动。运行环境只需与包匹配的 Linux 架构，不依赖 Workbench、Flow、Node.js 或 Rust 工具链。

## 首次启动

有校验文件时，在解压前运行 `sha256sum -c *.tar.gz.sha256`。以下命令在解压目录中执行：

```sh
umask 077
export URSI_MCP_DATA_DIR="$HOME/.local/share/ursi-mcp"
mkdir -p "$URSI_MCP_DATA_DIR"
export URSI_MCP_TOKEN_FILE="$URSI_MCP_DATA_DIR/admin.token"
[ -f "$URSI_MCP_TOKEN_FILE" ] || openssl rand -hex 32 > "$URSI_MCP_TOKEN_FILE"
./ursi-mcpd
```

访问 `http://127.0.0.1:8087`，使用 `admin.token` 中的值登录。OpenSSL 仅是生成令牌的一种方式，服务本身只读取现有的私有令牌文件。更换令牌后重启服务。

## 允许 MCP 服务连接

在数据目录放置 `mcp-policy.json`，登记地址须与文件里的完整端点一致。`allowedTools` 是部署许可上限，工具同时需要在页面显式授权，并在每次调用前确认。带凭据的登记还须匹配引用名；允许在该端点直接填写密钥时加 `"allowSecret": true`（密钥地址必须 HTTPS，回环 IP 除外）。

```json
[
  {"url":"https://service.example/mcp","credentialEnv":"TEAM_TOKEN","allowedTools":["search"]},
  {"url":"https://other.example/mcp","allowSecret":true}
]
```

需要凭据引用时，由部署方在同一数据目录创建 `credentials.json`，权限设为 `0600`。文件是引用名到 Bearer 令牌的 JSON 对象，例如 `{"TEAM_TOKEN":"<由部署方填入令牌>"}`。网页登记时填引用 `TEAM_TOKEN`，引用名与策略里的 `credentialEnv` 一致；或在凭据方式里选「直接填写密钥」，密钥保存在服务登记中且接口不回显。引用名须以大写字母开头，仅包含大写字母、数字和下划线。独立版没有凭据管理页面或 API，也不读取同名进程环境变量。无凭据服务选「无凭据」，无需创建 `credentials.json`。

变更策略或轮换凭据时，以同目录的私有临时文件原子替换。新会话读取最新值。策略或所需凭据不可用时拒绝建立连接。只授权信任的服务地址和 DNS。

## 部署与备份

- `URSI_MCP_BIND` 默认 `0.0.0.0:8087`。应用只接受从本机回环到达的请求，可将监听也限定为 `127.0.0.1:8087`。跨机器访问时在同机设置 HTTPS 反向代理，并配置 `URSI_MCP_HTTPS_HOST` 为浏览器使用的域名及可选端口。代理须保留该 `Host`，并将请求转发给回环监听地址。
- 将数据目录设为 `0700`。`store.json`（`0600`）记录服务、凭据引用、直接填写的密钥和工具设置，引用名对应的令牌值由部署方保存在 `credentials.json`，与 `admin.token` 分开管理。备份时按密钥文件处理这两个令牌文件和 `store.json`。
- 从原来带「环境变量」页面的独立版本升级时，先停机并私下备份 `store.json`。将其中顶层 `credentials` 对象移到 `credentials.json`，再从 `store.json` 删除该字段，保留 `servers` 与 `mcp-policy.json`。保持文件权限为 `0600`，原登记 ID 和引用名无需修改。
- 每个数据目录只能由一个进程使用。日志和管理 API 不输出管理令牌或已保存的凭据值。部署环境应限制谁可访问管理端，并用网络出口策略约束实例可达的目标。
