---
parent: ../../../SPEC.md
depends-on:
  - ../../shared/SPEC.md
  - ../agent-executor/SPEC.md
references:
  - ../../../../../docs/design/workbench/WEB-SHELL-AND-FLOW.md
---
# Flow 包

## 功能意图

让流程维护者直接编辑可发布的包文件，并从保存的版本启动运行。

## 关键功能与验收

### 包管理与运行入口

#### 验收

- 使用字符串数组显示目录；编辑器完整读入 FLOW.md 和附属文件，可新增、修改、移除附属文件。
- 验证与写入分开，更新发送全部文件和当前 revision；失败保留草稿。确认删除成功后返回目录。
- 启动参数接受 JSON 对象、可选 Run ID 和固定 default 工作区，进入返回 ID 对应的运行详情。默认方式不带执行器引用。选择平台方式后须选启用执行器的已发布 Agent 修订，启动时把 `{id,revision}` 作为顶层 `executorRef` 提交。
