---
parent: ../../SPEC.md
depends-on:
  - ../agent-runtime/SPEC.md
  - ../domain/SPEC.md
references:
  - ../../../sandbox-gateway/runtime/AGENT-CONTRACT.md
  - ../../../sandbox-gateway/runtime/bundle/session-service/README.md
---

# Agent CLI Adapter

## 功能意图

在沙箱内适配 Pi CLI 的启动、配置、RPC 输入输出和进程回收。session-service 拥有会话状态与客户端协议，Adapter 提供独立的进程接口与事件映射。

## 关键功能与验收

### Pi RPC 执行与事件

使用 Pi 1.5.0 长期 RPC 进程，逐条关联命令 ID，严格解析 JSONL 并映射文本与工具事件。

#### 验收

- `prompt` 接受响应与 `agent_end` 均不会单独结束任务，`agent_settled` 与最终 assistant stopReason 共同决定结果。
- 模型 error、aborted、length、异常退出和非法记录产生明确失败。
- 文本、工具 ID、标题、状态与必要内容映射为 ACP update，Unicode 行分隔符保留在同一 JSONL 记录中。
- 单记录、事件队列与命令等待有界，stderr 与提供方原始错误不进入日志或错误摘要。

### 隔离启动与取消

通过每会话 Linux subreaper 监督进程启动 Pi，服务生成独立运行配置，Pi 使用固定隔离参数和环境 allowlist。

#### 验收

- Pi 以非 root 身份运行，生产 UID/GID 为 1000，并清空补充组。
- 禁止自动加载扩展、MCP、skills、上下文、项目配置与模板，禁用自动重试和压缩。
- 取消先限时发送 clear_queue 与 abort，再清理全部后代，包括另起 session 或进程组的 Bash 工具。
- 清理使用 pidfd 与进程身份核对，监督进程确认全部后代回收后才退出。
- 服务父进程死亡触发清理，监督进程持有服务锁直到清理完成。

### 确定性验证

适配器解析测试与 session-service 的 fake RPC 子进程测试覆盖成功、失败、取消和重启路径。

#### 验收

- 错误请求 ID 不改变当前命令结果，快速事件与接受响应乱序仍产生正确终态。
- fake 通过相同进程启动、JSONL、降权、WebSocket 与回收路径执行。
- 真实模型验收由 Runtime 集成测试验证实际产物和仓库测试结果。
