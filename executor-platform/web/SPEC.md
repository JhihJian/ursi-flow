---
parent: ../../SPEC.md
depends-on:
  - ../../workbench/web/src/modules/definitions/SPEC.md
  - ../../workbench/web/src/modules/agent-backends/SPEC.md
  - ../../workbench/web/src/modules/patches/SPEC.md
references:
  - ../../docs/design/executor-platform/OVERVIEW.md
  - README.md
---
# 执行器平台管理前端

## 功能意图

管理员可独立编辑配置包、资源和执行器，检查后端，用当前 Agent 草稿试跑并发布固定版本。

## 关键功能与验收

### 独立管理与版本发布

#### 验收

- 根地址打开执行器目录。配置包文件编辑、草稿试跑、发布、停用和历史详情使用与 Workbench 接入时相同的组件。
- 独立登录后所有业务请求只发往本源 `/api/v2`。Workbench 的标签页令牌不能代替平台令牌。工作清单、样例工作包和 Flow 探测不属于管理页请求。
- 未登录的详情深链保留原地址，登录后可继续。服务错误使用页面的错误与重试控件，成功发布可打开服务返回的新修订。
