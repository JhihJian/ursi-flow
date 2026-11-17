---
parent: ../../SPEC.md
references:
  - ../runtime/AGENT-CONTRACT.md
  - ../gateway/CONTRACT.md
---

# 独立沙箱客户端

## 功能意图

以独立调用方身份接入 Gateway 和沙箱 ACP 服务，验证沙箱 Agent 执行能力，脱离 server、工作流和 Web 页面使用。

## 关键功能与验收

### 独立执行

创建沙箱、准备仓库、提交真实 Agent 任务、接收事件并验证结果，提供取消、停止和资源清理操作。

#### 验收

- 使用真实 Pi CLI 完成仓库修改，通过独立测试检查结果。
- 取消仅影响目标会话，终止后不遗留工具进程。
- 停止再启动保留工作区，删除后无所属容器和卷。
