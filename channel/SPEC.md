---
parent: ../SPEC.md
---

# channel

## 功能意图

channel 是通道控制层，负责运行中的交互与内容传输：SSH 命令执行、SFTP 文件传输、Agent ACP 会话传输、终端与 code-server、Chromium CDP、noVNC、应用预览端口的连接管理、字节传输、生命周期绑定与鉴权。它与 agent-runtime 的切分线：channel 管连接与帧传输（字节层），agent-runtime 管 ACP 会话语义与控制接口（协议层）。server 是它唯一的调用方，它不反向依赖 server。

连接对端是沙箱内由 sandbox-runtime bundle 注入的通道服务，端口与服务的对应关系见通道清单。

## 通道清单

| 通道 | 传输协议 | 对端服务 | 鉴权 | 生命周期 |
|---|---|---|---|---|
| SSH 命令执行 | SSH exec | sshd | 一次性凭据注入 | 运行期 |
| SFTP 文件传输 | SSH SFTP | sshd | 同 SSH | 运行期 |
| Agent ACP 会话 | WebSocket | bundle ACP backend | 会话 token | 会话期 |
| 终端 / code-server | WebSocket | bundle code-server | 会话 token | 运行期 |
| Chromium CDP | WebSocket | bundle Chromium | 本地回环限定 | 会话期 |
| noVNC | WebSocket | bundle noVNC | 会话 token | 运行期 |
| 应用预览 | HTTP/WS 端口代理 | bundle preview | 端口隔离 | 节点执行期 |

对端服务随 sandbox-runtime bundle 注入，端口约定见其 CONTRACT。骨架阶段各通道实现延后，先随运行面契约（C2）定稿连接建立与鉴权语义。

## 关键功能与验收

### 连接建立与鉴权

按通道清单建立到沙箱内服务的连接，凭据经沙箱创建规格注入，连接建立前校验，失败返回明确错误。

#### 验收

- 给定运行中的沙箱与已注入凭据，exec 与 ACP 通道可建立连接。
- 凭据缺失或过期时连接被拒绝，错误可区分原因。

### 传输与生命周期绑定

连接随其绑定的生命周期（会话期、运行期、节点执行期）建立与关闭；生命周期结束后连接与对端资源被清理。

#### 验收

- 绑定会话的通道在会话结束后关闭，对端服务资源被回收。
- 沙箱释放时全部通道连接关闭，无残留连接。
