---
parent: ../SPEC.md
references:
  - README.md
  - ../docs/design/workbench/PATCH-STUDIO.md
  - ../docs/design/workbench/WORK-LIST-DESIGN.md
  - ../docs/design/workbench/WORK-PATCH-GENERATOR-DESIGN.md
  - ../docs/design/workbench/EXECUTOR-DESIGN.md
  - ../docs/EXECUTOR-MCP.md
  - EXECUTOR-INTEGRATION.md
  - ../docs/design/workbench/FLOW-EXECUTOR-DESIGN.md
---

# 工作台

## 功能意图

工作台将[服务端](server/SPEC.md)与[浏览器界面](web/SPEC.md)组织为同一项目。用户通过同源 API 维护工作清单和工作包，使用执行器平台的已发布修订。配置包与执行器在独立管理页维护。启用 Flow 时可另外管理流程包与运行。

## 关键功能与验收

### 工作清单与资源转包

#### 验收

- 未接入外部服务也能创建、编辑和删除一次性或持续工作，按类别与进度状态组合筛选。
- 从平台登记的 MCP 服务选择资源，在工作项保存 Python 配方。每次主动生成一个文件型工作包，重试同一次请求只发布一个包。删除工作项时保留包、文件及生成来源，每包当前至多归属一个工作项。详见[工作清单与工作包来源](../docs/design/workbench/WORK-LIST-DESIGN.md)。

### 工作包生成器

#### 验收

- 关闭 Flow 时仍能发布生成器修订、独立试运行并读取只读文件，也能从工作项显式生成关联工作包。新版不改变已有绑定。
- 生成记录可查回固定修订、输入摘要和结果。同 ID 重试不重复运行，改动请求返回 409。包的生成来源可跳回原记录。

### 工作包与配置包目录

#### 验收

- 虚拟目录可独立创建和读写。工作包、配置包各自保存元信息与目录引用。输入包名即可创建包及其目录；工作包自由管理文件，配置包分别维护提示词、技能与 MCP。读写无需 Flow 或执行环境。

### 前后端联合验收

#### 验收

- 从工作台 Cargo 工作区构建 Server，从 `web/` 构建界面。发布与修订管理使用平台管理页；工作台可选择旧修订执行。
- 发布执行器定义不会启动运行。Agent 按版本运行时使用发布时保存的配置快照和后端绑定。执行路径见[执行器设计](../docs/design/workbench/EXECUTOR-DESIGN.md)。

### 通过 MCP 执行一次尝试

#### 验收

- 已认证的调用方可按小写 UUID 提交指令和可选工作包：指定 Agent 修订按版本运行。草稿试跑仅在平台管理页可用，不发布修订。同 ID 重复提交相同参数只对应一次运行，改动参数返回 409。
- 可按原 ID 查询或取消。启动回执丢失后，GET 可查回原尝试，不发起运行。确认终态并收集输出后，可通过只读目录列出和读取文件。见[模块规格](server/src/work/executor/SPEC.md)与[执行器接入说明](EXECUTOR-INTEGRATION.md)。
