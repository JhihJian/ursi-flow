---
parent: ../SPEC.md
references:
  - ../gateway/CONTRACT.md
  - README.md
---

# 通用沙箱客户端

## 功能意图

为工具和操作者提供 Gateway 控制面、逻辑端点转发和 SSH/SFTP 工作区访问。仅使用 SSH 的沙箱可以独立使用这些能力。需要 Agent 会话时，由[可选 ACP 消费方](consumers/acp/SPEC.md)在 bridge 之上实现会话协议。

## 关键功能与验收

### 独立控制与仓库访问

CLI 与库 API 经 Gateway HTTP 创建、查询、启动、停止和删除沙箱，经指定公钥身份访问 `agent` 工作区。

#### 验收

- 关闭默认 Cargo features 后仍可构建库和 CLI，并通过 Gateway 和 bridge 测试；帮助仍列出 `gateway`、`forward`、`proxy`、`ssh-config`、`ssh` 和 SFTP，调用 `acp` 返回未知命令。通用操作无需 ACP 配置或 Pi 服务。
- Gateway Bearer 从环境变量或文件读取，URL、argv 和输出不含凭据。创建请求使用管理员已注册的镜像，调用方按 HTTP 202 返回的实际状态轮询完成，失败返回非零退出码。
- SSH 使用指定私钥和独立 known_hosts，禁用密码认证，每次操作有期限。
- 主用户验收只使用 CLI：新建沙箱并等待就绪，通过 SSH 在空工作目录编写 `index.html`，通过 SFTP 下载并核对 SHA-256。删除后确认 404，下载页面在浏览器中显示 `Hello World`。

### 逻辑端点 bridge

`forward` CLI 和 `Bridge` 库 API 将 TCP 连接转发给指定沙箱的逻辑端点。上层协议的解析归消费方。

#### 验收

- 先查询 `/api/v1/sandboxes/{id}/endpoints`，仅转发 `ready` 端点。端点 DTO 只接受 `name`、`bundle`、`protocol`、`port`、`state`、`ready`，拒绝 `address`、`visibility` 和其他未知字段。
- 每条本地 TCP 连接独立拨通 `/api/v1/sandboxes/{id}/connect/{endpoint_name}`，携带 Gateway Bearer 和 `ursi-tcp-v1` 子协议。调用方只能指定逻辑端点和本地监听地址。
- fake HTTP/WS 对端可观察到协议协商、端点路径、身份、双向有界字节转发、`eof` 半关闭和 Ping/Pong。握手失败关闭对应本地连接，取消或退出时回收连接。

### 标准 SSH 工具接入

`proxy` 子命令把本地 stdin/stdout 直通到逻辑端点，充当 `ProxyCommand`；`ssh-config` 打印一次性静态 `Host ursi-*` 块，使只支持 `ssh user@host` 的工具无需改造即可接入。两者不解析隧道内的 SSH 协议。

#### 验收

- `proxy HOST [ENDPOINT]` 从 `ursi-SANDBOX_ID` 形式主机名解析沙箱 ID，主机名缺失前缀或 ID 非法时在访问 Gateway 前失败。stdout 只承载隧道字节，不输出结构化结果行；错误只写 stderr 并返回非零退出码。
- `proxy` 沿用逻辑端点就绪校验、Bearer 鉴权、`ursi-tcp-v1` 子协议、`eof` 半关闭和 20 秒 Ping 保活，与 `forward` 使用同一中继实现。
- `ssh-config` 只输出静态文本，不写入文件也不访问 Gateway；输出不含 Gateway Bearer 或私钥内容。`--host-key-policy pin` 记录 `UserKnownHostsFile`，`ignore` 改为 `/dev/null` 并关闭严格校验。
