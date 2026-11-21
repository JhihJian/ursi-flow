# 平台 MCP 接入契约

## 页面登记

在「平台设置 → 环境变量」保存最小权限的 `GITHUB_PAT_TOKEN`，然后在「平台 MCP 服务 → 登记服务」中填写 `github` 和 `https://api.githubcopilot.com/mcp/`，从下拉列表选择该变量，确认地址后添加。无凭据服务选择「无凭据」。登记只保存配置，「浏览资源」才连接。默认部署无需策略文件。

页面提交 `binding: "platform"`。每次连接使用所选平台变量的最新值，删除变量会阻止新连接，不会读取同名进程变量。管理令牌持有者能指定凭据接收方，应仅向受信任管理员分发该令牌。远程服务会收到所选变量的实际值。

## 部署级访问限制

部署者可在 Server 的私有工作存储目录 `work/mcp-policy.json` 中限制允许的地址和凭据组合。文件存在时，页面登记和后续连接也须通过检查。使用普通文件、权限 `0600`，以原子替换方式维护。文件内容是完整端点与凭据变量名的配对列表，最多 64 KiB。例如：

```json
[
  {"url":"https://feedback.example.org/mcp","credentialEnv":"FEEDBACK_READ_TOKEN"},
  {"url":"http://127.0.0.1:7100/mcp"}
]
```

策略文件只含变量名。凭据值可在「平台设置 → 环境变量」中设置，也可由部署者注入 Server 进程环境。管理员需确保端点、DNS 和受信任的 TLS 服务由预期运营方控制。一个授权对允许工作台用户以该服务身份读取资源；应使用只读、仅覆盖可共享材料的凭据。平台没有资源级租户 ACL。明文 HTTP 传输凭据仅限字面回环 IP。端点不接受用户信息、查询串或片段，不跟随重定向，也不使用环境代理。

授权按完整 URL 字符串和可选变量名精确匹配。文件策略模式（省略 `binding` 或设为 `policy`）始终要求该文件。要在受限实例阻止全部新会话，将授权列表置为 `[]`；远端即时撤销可通过吊销凭据完成。

## 平台环境变量

平台变量的替换立即作用于新连接。只有文件策略模式在平台变量缺失时使用部署注入的同名进程变量。

下列接口使用 Workbench 管理令牌认证。持有令牌的用户均可更改平台变量。接口只列出平台管理的名称，不枚举宿主环境；创建、替换和删除均只返回 `{name}`。

| 方法与路径 | 行为 |
| --- | --- |
| `GET /api/v2/platform-env` | 返回变量名字符串数组。 |
| `POST /api/v2/platform-env` | 输入 `{name,value}`。同名已存在返回 409。 |
| `PUT /api/v2/platform-env/{name}` | 输入 `{value}`，替换整个值。不存在返回 404。 |
| `DELETE /api/v2/platform-env/{name}` | 删除平台值。不存在返回 404。 |

最多 128 项，变量名匹配 `[A-Z][A-Z0-9_]{0,127}`，值为 1 至 8192 字节的 UTF-8 文本，不能含 NUL。用作 MCP Bearer 凭据时，值必须都是可打印的非空格 ASCII 字符。平台值不会写入进程环境或注入执行器、Flow 和 Python 脚本。

平台值以明文保存在私有 `$URSI_DATA_DIR/work/work.json`（文件权限 `0600`）。该文件及其备份应按凭据管理；跨网络操作使用 HTTPS，代理日志不得记录请求正文。需要将凭据保存在外部密钥系统时，可只使用部署注入的进程变量。

## MCP 管理 API

| 方法与路径 | 输入或输出 |
| --- | --- |
| `GET /api/v2/mcp-servers` | 返回服务记录数组。 |
| `POST /api/v2/mcp-servers` | 输入 `{name,url,credentialEnv?,binding?}`，返回含 `id` 的服务记录。只登记配置，不发起连接。 |
| `DELETE /api/v2/mcp-servers/{id}` | 删除登记，返回 `{id}`。旧工作包保留生成来源。 |
| `GET /api/v2/mcp-servers/{id}/inspection` | 返回 `{server,resources}`。`server` 含当前 `protocolVersion`、`discoveryMethod`、`supportedVersions`、自报的 `name/version/title`、`declaredCapabilities`、`instructions` 和三个常用能力标记。旧握手的 `supportedVersions` 为 null；未声明资源能力时不发送列表请求。 |
| `GET /api/v2/mcp-servers/{id}/resources` | 新建会话并翻页，返回 `[{name,title?,uri,mimeType?,description?,size?}]`。 |
| `POST /api/v2/mcp-servers/{id}/resources/read` | 输入 `{uri}`，返回 `{contents:[{uri,mimeType?,text|blob}]}`。只用于界面预览，不写工作项或目录。 |

连接使用官方 Rust MCP SDK `rmcp` 的 Streamable HTTP 客户端，先用 `2026-07-28` 的 `server/discover` 查询；旧握手协商 `2025-11-25`、`2025-06-18` 或 `2025-03-26`。初始化后携带协商版本及服务端给出的会话 ID。有会话 ID 时限时尝试 `DELETE`。响应可通过 JSON 或发起请求的 POST 所对应的 SSE 返回，不发起后台 GET，也不重连或重放。资源发现最多 32 页、1024 条，最多等待 25 秒。发现、读取预览和转换合计最多 4 个并发请求。远端 JSON-RPC 错误和脚本诊断不回显原文。

资源预览复用同一条授权与限额链路：每次预览新建会话、只发 `resources/read`，响应仍受 4 MiB 上限约束。界面把 `text` 按原文展示，不解释 Markdown 或 HTML；`blob` 只显示大小。预览不是生成的前置步骤，生成仍会自行重新读取。

## 工具、提示词与资源模板

在服务检查页切换「工具目录」「提示词目录」或「资源模板」时才请求该目录。三类发现复用已登记的端点、凭据、短会话与限额。每页按游标继续，最多 32 页、1024 项、合计 4 MiB。工具保留输入 schema，提示词保留参数说明，模板保留 URI 模式。目录可刷新。

以下路径接在 `/api/v2/mcp-servers/{id}` 后：

| 操作 | 请求与结果 |
| --- | --- |
| `GET /catalog/{kind}` | `kind` 为 `tools`、`prompts`、`templates`，返回相应 MCP 目录项数组。 |
| `PUT /settings` | 完整替换 `{allowedTools,githubToolsets,githubReadOnly}`，返回保存值。缺省为空列表和 `false`。 |
| `POST /tools/call` | `{name,arguments}`，参数为 JSON 对象，返回工具原始 MCP 结果，包括 `isError`。 |
| `POST /prompts/get` | `{name,arguments}`，参数值为字符串，返回 MCP 消息，按数据展示。 |

工具表格的「允许调用」开关修改当前服务的本地精确名称白名单。仅发现或配置远端工具集不会授权。每次手动调用须确认，后端检查白名单；若存在部署策略文件，匹配的授权条目还须含 `allowedTools` 并列出该名称。调用不重试，超时需先核实远端状态。工作包配方、Flow 和执行器不会自动获得这些工具。

官方默认 GitHub 端点 `https://api.githubcopilot.com/mcp/` 的「工具设置」可按行启停 `repos`、`issues` 等工具集并设置只读模式。清空显式选择恢复 GitHub 默认工具集。它们映射到 `X-MCP-Toolsets` 和 `X-MCP-Readonly`；其他服务不能设置这些头。只读开关由 GitHub 实施，实际权限还受 PAT 和组织策略限制。

当前平台使用远程 Streamable HTTP 短会话。资源模板通过输入展开后的 URI 读取，未实现长连接订阅、变更通知、客户端采样、交互式输入或本地 stdio 进程托管。

## Python 输入与结果

`transform(item, resources)` 的 `item` 仅含 `id`、`title`、`description`、`category`、`status`。后两个字段取自生成开始时的工作项，分别表示工作类别与办理状态，取值见[工作清单契约](../worklist/HTTP.md)。`resources[alias]` 包含 `serverId`、`uri` 和 `contents` 数组，数组里的每一项含 `uri`、可选 `mimeType` 和 `text` 或标准 Base64 `blob`。生成来源中的 `sha256` 取自该数组的紧凑 UTF-8 JSON，`readAt` 为 Unix 毫秒。

```python
def transform(item, resources):
    text = resources['feedback']['contents'][0]['text']
    return {'name': item['title'], 'files': [{'path': '材料/反馈.md', 'text': text}]}
```

转换使用 Linux 用户命名空间、`/usr/bin/bwrap`、系统 `/usr/bin/python3` 和 `libseccomp.so.2`，部署需支持 bwrap 的 `--disable-userns`。解释器以清空的环境和只读运行库启动，不挂载工作目录、用户家目录或 `/proc`。可信启动器预加载 `base64`、`collections`、`csv`、`datetime`、`hashlib`、`io`、`itertools`、`json`、`math`、`re` 等模块，然后安装内核系统调用白名单。此后仅保留管道 I/O、进程自身内存管理、计时和退出所需的调用。脚本在内存中处理材料，只能导入已加载的模块或无需读取文件的内建模块。内核拒绝打开文件、创建套接字和启动子进程。

| 限额 | 值 |
| --- | --- |
| 单次生成 | 45 秒，最多 32 个资源引用，脚本 64 KiB |
| 外部响应与输入快照 | 每个 MCP 响应 4 MiB，资源内容累计 4 MiB |
| Python | 地址空间 192 MiB，CPU 2 秒，含启动与管道读写的总时长 6 秒 |
| 生成文件 | 1 至 128 个，正文合计 4 MiB，输入输出 JSON 各 6 MiB |

包名最长 80 个字符，文件路径遵循虚拟目录规则。文件正文只接受 `text` 或 `blob` 之一。转换器在校验全部文件后交付结果，由调用方复核工作项修订并发布。

在具备上述隔离设施的主机上，可使用 `cargo test --manifest-path workbench/server/Cargo.toml --lib work::mcp::tests -- --include-ignored` 连同真实隔离用例一起验收。
