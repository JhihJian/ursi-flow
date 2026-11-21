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

在数据目录放置 `mcp-policy.json`，登记地址须与文件里的完整端点一致。使用凭据时，在「环境变量」页面保存同名变量，登记时选择该变量。`allowedTools` 是部署许可上限，工具同时需要在页面显式授权，并在每次调用前确认。

```json
[
  {"url":"https://service.example/mcp","credentialEnv":"TEAM_TOKEN","allowedTools":["search"]}
]
```

只登记信任的服务地址和 DNS。无凭据服务省略 `credentialEnv`。变更策略时原子替换文件，新会话立即使用最新策略。缺失、损坏或空策略会阻止登记和出站连接，不影响查看已有登记。管理员令牌与出站凭据分开加载，进程环境中的同名变量不会被用作出站凭据。

## 部署与备份

- `URSI_MCP_BIND` 默认 `0.0.0.0:8087`。应用只接受从本机回环到达的请求，可将监听也限定为 `127.0.0.1:8087`。跨机器访问时在同机设置 HTTPS 反向代理，并配置 `URSI_MCP_HTTPS_HOST` 为浏览器使用的域名及可选端口。代理须保留该 `Host`，并将请求转发给回环监听地址。
- 将数据目录设为 `0700`。服务记录和出站凭据以原子方式写入其中的 `store.json`（`0600`）。备份时按密钥管理 `store.json` 和 `admin.token`；升级只需替换程序和 `web/`，保留私有数据目录。
- 每个数据目录只能由一个进程使用。日志和管理 API 不输出管理令牌或已保存的凭据值。部署环境应限制谁可访问管理端，并用网络出口策略约束实例可达的目标。
