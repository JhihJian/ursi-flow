---
parent: ../../../SPEC.md
depends-on:
  - ../../shared/SPEC.md
references:
  - ../../../../../docs/design/workbench/WEB-SHELL-AND-FLOW.md
---
# 运行观测

## 功能意图

浏览 runtime job 与执行事实，并请求停止活动运行。

## 关键功能与验收

### 状态和历史

#### 验收

- 目录显示运行 ID、Flow 与状态，详情读取对应 job 和 history，展示配置、参数和执行事实。
- 活跃时定期刷新，终态停止自动刷新。切换运行取消旧读取，读取失败可重试。
- 停止运行需要确认，重新读取的状态以服务端结果为准。
