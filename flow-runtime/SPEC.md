---
parent: ../SPEC.md
references:
  - docs/flow-spec.md
---

# Flow Runtime

## 功能意图

独立于 Rust 服务执行 FLOW.md 包。引擎决定路由，宿主实现命令与 Agent 调用。运行记录保留每次节点执行和结果。

## 关键功能与验收

### 流程定义与本地运行

加载 Flow 包及其引用闭包，校验图、动作和变量，根据结果边推进；节点需要的能力由宿主预检。

#### 验收

- 参考解析用例可直接运行。缺失资源、非法图和子 Flow 引用环在运行前拒绝。
- 新建和复用节点使用同一 Pi 会话；独立工具回执驱动下一跳，历史记录保留每次 outcome。
- 在无 Rust workspace、Server、Gateway 的目录安装打包产物，能加载示例。
