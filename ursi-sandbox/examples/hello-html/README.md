# 用 ursi-sandbox-client 开发 Hello World 页面

目标：在新沙箱的空目录里写 `index.html`，把页面带回本机，删除沙箱后仍能在浏览器打开它。所有沙箱操作都由 `ursi-sandbox-client` 发起。此场景使用 SSH 执行开发者提供的 Shell 命令，不调用 Pi 或 Python 验收脚本。

## 准备

使用已部署的 [Gateway](../../gateway/README.md) 和启用 SSH 的 Runtime。安装 `ursi-sandbox-client`、OpenSSH 客户端、Bash、jq 和 sha256sum。以下命令从 `ursi-sandbox/` 运行。向部署者获取以下配置（路径和地址替换为本机值）：

```bash
export PATH="$PWD/target/debug:$PATH"
export URSI_GATEWAY_URL=http://127.0.0.1:8899
export URSI_GATEWAY_KEY_FILE=/private/gateway-key
export SSH_IDENTITY=/private/id_ed25519
export SANDBOX_SPEC=/private/hello-html-spec.json
```

`SANDBOX_SPEC` 是 [创建规格](../../client/README.md)，使用部署者提供的镜像、bundle URL、SHA-256 和 profile 名称，须有名为 `ssh` 的公开就绪端点（容器端口 2222）。`SSH_IDENTITY` 对应该 profile 允许登录的公钥。管理员部署已有环境后，验收用户无需 sudo 或 Docker 权限。

## 执行和检查

```bash
bash examples/hello-html/accept.sh
```

[accept.sh](accept.sh) 是下列 CLI 命令的 Bash 清单，负责从 JSONL 中取出 ID、端点并限时轮询。远端的 [develop.sh](develop.sh) 由普通 `agent` 用户在 `/ursi/workspace/hello-html` 下写入页面，不接收预制 HTML 文件。

| 步骤 | 实际 CLI 命令 | 通过条件 |
| --- | --- | --- |
| 创建 | `ursi-sandbox-client gateway create "$SANDBOX_SPEC"` | 返回新沙箱 ID |
| 等待就绪 | `ursi-sandbox-client gateway status "$id"`、`ursi-sandbox-client gateway endpoints "$id"` | 状态为 `running`，无未完成操作，取得 SSH 地址 |
| 开发页面 | `ursi-sandbox-client ssh "$host" "$port" "$SSH_IDENTITY" "$known_hosts" examples/hello-html/develop.sh` | 空目录中生成 `index.html` 并返回其 SHA-256 |
| 下载 | `ursi-sandbox-client sftp-get "$host" "$port" "$SSH_IDENTITY" "$known_hosts" "$local_html" /ursi/workspace/hello-html/index.html` | 下载摘要与远端一致，包含 `<h1>Hello World</h1>` |
| 删除 | `ursi-sandbox-client gateway delete "$id"`，再用 `gateway status` 确认 | 明确收到 `404 not_found`。连接故障不算删除成功 |

最后打开终端 `Verified:` 后面的本地 HTML 文件，确认页面正文显示 **Hello World**。不需要启动 Web 服务。验收失败时脚本返回非零；本地文件用于取件，宿主 `/tmp` 下的文件不会永久保留。
