---
parent: ../../SPEC.md
depends-on:
  - ../../../flow-core/src/domain/SPEC.md
references:
  - ../../../contracts/gateway/v1/README.md
  - ../../../ursi-sandbox/gateway/CONTRACT.md
  - ../../../ursi-sandbox/runtime/CONTRACT.md
---

# Channel

## 功能意图

`sandbox-access` 内的独立连接模块，负责连接、鉴权、命令与文件传输、ACP 消息传输及原生服务的字节流。依端点描述选择直连或 Gateway 隧道，远端会话由 session-service 管理。这里的长度前缀 JSON 帧与 Runtime `/acp` WebSocket 接入分开。

SSH 命令、PTY 终端与 SFTP 共用 sshd；ACP 对接 session-service；IDE、CDP、noVNC 和应用预览对接各自原生服务。协议适配集中在本 crate 内，不要求一类通道对应一个端口或独立进程。

## 关键功能与验收

### 连接与传输选择

从 core 端口接收获准端点，按服务协议鉴权连接，可选择直连或经 Gateway tunnel 承载相同上层协议。内部端点始终受网络与调用身份约束。

#### 验收

- 同一个 SSH 或 ACP 测试在直连与隧道下具有相同请求结果。
- 错误凭据、不可达端点和隧道禁用返回可区分错误。
- 连接内部服务不要求创建公开端口映射。

### 协议接入

SSH 提供命令执行与终端，SFTP 提供文件传输，ACP 传输会话请求与事件，通用字节流可承载其他原生服务的协议。

#### 验收

- SSH 执行返回退出状态与输出，SFTP 文件往返保持内容完整。
- 独立 SSH 命令执行无需创建 agent 会话。Server 的 script 节点尚未绑定此通道。
- ACP 消息关联标识和事件顺序保持完整，Channel 不重试 agent prompt。
- 通用字节流向测试端点发送的数据可按序读回；实际 IDE、CDP 或预览服务需由环境另行提供。

### 连接关闭与观测

管理本地连接资源，发送显式关闭请求并把连接故障报告调用方。对端会话及子进程由 session-service 清理。记录命令结果、连接状态和传输计数，供可选观测采集。

#### 验收

- 沙箱释放或调用方取消连接时，本地连接回收。
- 网络断开报告连接故障，不自动取消或重建 agent 会话。
- 关闭会话请求交给会话控制层执行，对端确认后可观察到资源释放。
- 缺少观测消费者不影响连接功能，观测记录不包含凭据明文。
