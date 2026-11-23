---
parent: ../../SPEC.md
depends-on:
  - ../../workbench/web/src/modules/definitions/SPEC.md
  - ../../workbench/web/src/modules/agent-backends/SPEC.md
  - ../../workbench/web/src/modules/patches/SPEC.md
  - ../server/src/work/executor/SPEC.md
references:
  - ../../docs/design/executor-platform/OVERVIEW.md
  - README.md
---
# 执行器平台管理前端

## 功能意图

管理员在 Agent 工作区运行已发布的执行器修订，查看实时回复、工具状态和只读制品。平台管理功能用于编辑配置包、检查后端、试跑草稿和发布修订。

## 关键功能与验收

### 独立管理与版本发布

#### 验收

- 根地址打开 `/agent`。导航保留执行器目录、配置包、资源库和后端管理。配置包文件编辑、草稿试跑、发布、停用和历史详情继续使用共享管理组件。
- 普通构建需要平台管理员登录。显式启用的 `lan-preview` 构建不提示输入令牌，只通过可信网段上的 HTTPS 代理访问回环 API。请求只发往本源 `/api/v2`，代理拒绝外部来源及跨源请求，管理员令牌只存在于服务端。工作清单、样例工作包和 Flow 探测不属于管理页请求。
- 未登录的详情深链保留原地址，登录后可继续。服务错误使用页面的错误与重试控件，成功发布可打开服务返回的新修订。

### Agent 工作区

#### 验收

- AI Elements 对话和输入组件绑定管理员选中的执行器 ID 与修订，提交一条任务指令对应一个 `attemptId`。每次新尝试由平台创建独立 ACP v2 会话，浏览器只访问同源 HTTP API。
- 刷新和回执丢失时按原尝试 ID 查询，不重发任务。停止请求和确认取消分别显示；待核实的尝试可重新查询，放弃跟踪前须确认。
- 运行期间按 `nextCursor` 读取回复和工具状态，合并同一消息的片段；收到终态后读完事件尾页。轨迹缺口独立显示。回复的 Markdown 不加载外部资源；制品只从平台已发布目录读取。
