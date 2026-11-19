---
parent: ../../SPEC.md
depends-on:
  - ../shared/SPEC.md
  - ../modules/work-list/SPEC.md
  - ../modules/work-detail/SPEC.md
  - ../modules/workspaces/SPEC.md
  - ../modules/patches/SPEC.md
  - ../modules/sources/SPEC.md
  - ../modules/definitions/SPEC.md
  - ../modules/flows/SPEC.md
  - ../modules/runs/SPEC.md
  - ../modules/config/SPEC.md
  - ../modules/chat/SPEC.md
references:
  - ../../DESIGN.md
  - ../../DESIGN-v2.md
---
# 应用装配

## 功能意图

以工作清单为入口，让经办人和验收人能从同一工作台进入办理详情、查看定义和使用当前部署提供的工具。

## 关键功能与验收

### 路由与登录

#### 验收

- `/` 进入 `/items`；`/items/:id` 和 `/items/:id/deliveries/:version` 打开同一工作项详情。工作包（`/work-patches`）、配置包（`/config-patches`）、Echo 工作区（`/workspaces`）、派工模板（`/templates`）、SOP（`/sops`）、资源和执行器各有独立入口与版本深链。
- 工作清单与侧栏提供 `/workspaces` 入口；`/workspaces`、`/workspaces/new`、`/workspaces/:id` 和 `/workspaces/:id/result` 分别打开工作包列表、新建、准备和执行结果。派工模板的全部子路由在 `/templates` 下，读取和发布仍走 `/api/v2/packages`。
- `/packages` 和 `/packages/new` 是用户熟悉的旧入口，直接跳到 `/workspaces` 和 `/workspaces/new`，不弹派工模板目录或表单。
- 业务页面只从各模块导出的路由或页面组件接入，应用装配不复制业务实现；业务模块可以用独立测试路由或固定响应单独验收。
- 受保护页面在原地址登录，保留查询参数和片段。退出或收到当前令牌的 401 后隐藏业务数据并可重新登录。旧会话迟到的 401 不影响新登录。本地对话保留独立演示入口，无令牌也可使用。
- 未知地址提供返回工作清单的链接且可点击。业务页面加载失败可以重新打开原地址。
- 开发代理把 `/api/v1` 和 `/api/v2` 同时转发到同一个服务地址，页面深链仍由开发服务器返回前端入口。

### 导航与可选模块

#### 验收

- 桌面侧栏与移动抽屉提供相同分组。日常工作含工作清单、工作包、Echo 工作区和外部来源，工作定义含配置包、SOP、派工模板、资源库和执行器。运行工具保留 `/flows`、`/runs`、`/flow-config` 及原有深链。
- 登录后分别探测 `/api/v2/sources` 和 `/api/v1/flows`。仅对应集合返回 404 时收起该模块的所有导航项；直接打开该模块仍能返回清单。单条记录的 404 不影响导航。
- 集合为空仍保留入口。其他服务故障显示对应错误，能单独重试，不阻塞其他模块。退出后不沿用先前会话的探测结果。
- 抽屉导航后关闭，页面标题与面包屑反映当前位置。明暗与主色独立保持；弹窗、通知和跳到主内容的链接可用键盘操作。
