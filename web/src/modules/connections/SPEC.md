---
parent: ../../../SPEC.md
depends-on:
  - ../../shared/SPEC.md
  - ../../../../server/src/connections/SPEC.md
references:
  - ../../../DESIGN.md
---

# 模型连接前端模块

## 功能意图

为模型服务维护者提供连接配置、凭据引用与模拟验证入口。通过共享 API 管理连接，供角色工作室选择。页面明确区分演示验证结果与真实执行链路中的模型认证。

实现分层：`routes.tsx` 以 `lazy` 加载 `ConnectionsView.tsx`（`handle.nav = true` 注册一级导航），列表读取走 `useResource`，卡片、弹窗草稿、验证结果与写操作状态都是组件局部 `useState`，未保存保护来自共享 `useUnsavedChanges`。保存结果以叠加层作用在接口列表上，成功后不发第二次列表请求。界面使用 `.page-stack`、`.panel`、`.toolbar` 与共享 `Modal` / `Button` / `Input` / `ResourceState`。

## 关键功能与验收

### 连接列表与配置维护

通过 `/connections` 提供连接卡片列表，展示名称、服务提供方、模型、基础地址与凭据引用，并通过弹窗创建或编辑连接。

实现约定：每张卡片是 `article`，标题用 `h2`，删除按钮以 `aria-label="删除 <名称>"` 提供可访问名称，验证按钮名为 `模拟验证`、编辑按钮名为 `编辑`。弹窗标题为 `新建模型连接` / `编辑模型连接`，表单 `#connection-form` 用 `label` 包裹控件保持 `getByLabel` 语义。关闭弹窗（取消、Esc、遮罩）都先 `await canLeave()`。

#### 验收

- 列表通过 GET `/connections` 获取，支持名称、服务提供方、模型与地址搜索，显示连接数和服务提供方数量。
- 加载、失败重试、无连接与搜索无匹配分别呈现，空状态提供创建或清空搜索操作。
- 新建与编辑弹窗包含 name、provider、baseUrl、model、credentialRef 字段，保存通过 POST `/connections` 或 PUT `/connections/:id` 执行。
- 必填项缺失或地址非法时保留输入并显示原因。HTTP(S) 地址不接受内嵌认证信息、查询参数或片段。
- 保存成功后列表采用 API 返回配置，刷新页面后读取到持久化结果。保存失败时弹窗保留草稿。
- 弹窗在窄屏可读，键盘焦点受约束，关闭与离开页面时未保存内容需要确认。

### 凭据引用与模拟连接验证

凭据输入仅接受引用标识。连接验证通过 POST `/connections/:id/test` 返回 `{ok, message, latency}`，结果明确标记为模拟连接验证。

实现约定：验证中的连接记录在 `testing` 映射里并禁用重复提交，结果写入 `results[connectionId]` 并以 `role="status"` 呈现 `模拟连接验证 · 通过` / `模拟连接验证 · 未通过`；保存成功或删除后清除该连接的旧结果。

#### 验收

- 列表与弹窗没有密钥输入项，凭据字段提示仅填写引用标识。
- 验证有进行中状态，成功或失败展示 API 返回消息，存在耗时时显示模拟耗时。
- API 请求失败显示可读错误，可再次验证。同一连接请求进行中不重复提交。
- 页面说明模拟验证不代表真实网络连通性或模型认证，修改连接后清除旧验证结果。

### 删除与引用冲突

删除需要确认，引用约束由 API 判断。

实现约定：删除先经共享 `confirmAction`（`confirmLabel` 为 `删除连接`），请求失败把可读原因写入 `role="alert"` 横幅并同时发错误通知，卡片保留在列表中。

#### 验收

- 确认后通过 DELETE `/connections/:id` 删除，无引用连接成功后从列表移除。
- 被角色引用的连接删除失败时展示接口冲突原因，并保留列表记录。
- 操作成功反馈只在请求完成后展示，服务错误使用共享错误处理。

## 模块职责与验收边界

- 本域页面（`ConnectionsView.tsx`）、弹窗草稿与验证展示归本目录，复用 shared API、DTO、UI 和反馈能力，角色与连接数据只经共享 API 访问。
- 组件测试使用 Vitest + Testing Library：`ConnectionsView.test.tsx` 用 `createMemoryRouter` + `RouterProvider` 覆盖草稿隔离、保存失败与未保存确认、模拟验证消息与耗时、新建弹窗字段名称、以及删除引用冲突保留记录。
- 独立验收使用持久化 mock API，检查配置 CRUD、搜索空态、模拟验证、删除冲突、失败恢复及未保存保护。
- mock 验证只证明配置操作和页面反馈，不证明运行时能力适配、真实凭据解析或模型认证。
- 联合验收连接真实 connections、roles、runs、存储及凭据来源，验证引用事务、快照隔离、敏感信息隔离与真实执行认证。
