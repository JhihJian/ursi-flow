# 平台 MCP 接入契约

## 管理员授权

工作台 API 令牌用于调用管理接口。出站授权另由管理员在 Server 的私有工作存储目录 `work/mcp-policy.json` 中配置。使用普通文件、权限 `0600`，以原子替换方式维护。文件内容是完整端点与凭据变量名的配对列表，最多 64 KiB。例如：

```json
[
  {"url":"https://feedback.example.org/mcp","credentialEnv":"FEEDBACK_READ_TOKEN"},
  {"url":"http://127.0.0.1:7100/mcp"}
]
```

策略文件只含变量名。管理员为服务进程设置凭据值，并确保端点、DNS 和受信任的 TLS 服务由预期运营方控制。一个授权对允许工作台用户以该服务身份读取资源；应使用只读、仅覆盖可共享材料的凭据。平台没有资源级租户 ACL。明文 HTTP 传输凭据仅限字面回环 IP。端点不接受用户信息、查询串或片段，不跟随重定向，也不使用环境代理。

授权按完整 URL 字符串和可选变量名精确匹配。缺少策略时列表仍可打开，登记和连接均被拒绝。删除授权会阻止新会话；远端即时撤销可通过吊销凭据完成。

## 管理 API

| 方法与路径 | 输入或输出 |
| --- | --- |
| `GET /api/v2/mcp-servers` | 返回服务记录数组。 |
| `POST /api/v2/mcp-servers` | 输入 `{name,url,credentialEnv?}`，返回含 `id` 的服务记录。只登记配置，连接检查使用资源发现接口。 |
| `DELETE /api/v2/mcp-servers/{id}` | 删除登记，返回 `{id}`。旧工作包保留生成来源。 |
| `GET /api/v2/mcp-servers/{id}/resources` | 新建会话并翻页，返回 `[{name,uri,mimeType?}]`。 |
| `POST /api/v2/mcp-servers/{id}/resources/read` | 输入 `{uri}`，返回 `{contents:[{uri,mimeType?,text|blob}]}`。只用于界面预览，不写工作项或目录。 |

连接采用 MCP Streamable HTTP，协商 `2025-11-25`、`2025-06-18` 或 `2025-03-26`。发送初始化完成通知，此后携带协商版本和服务端给出的会话 ID。资源发现最多 32 页、1024 条，最多等待 25 秒。发现、读取预览和转换合计最多 4 个并发请求。远端 JSON-RPC 错误和脚本诊断不回显原文。

资源预览复用同一条授权与限额链路：每次预览新建会话、只发 `resources/read`，响应仍受 4 MiB 上限约束。界面把 `text` 按原文展示，不解释 Markdown 或 HTML；`blob` 只显示大小。预览不是生成的前置步骤，生成仍会自行重新读取。

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
