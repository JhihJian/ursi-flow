---
parent: ../../../SPEC.md
depends-on:
  - ../../shared/SPEC.md
  - ../../../../server/src/roles/SPEC.md
references:
  - ../../../DESIGN.md
---

# 角色管理前端模块

## 功能意图

为角色维护者提供工作室，集中编辑角色身份、系统提示词、执行器、模型连接、文本 Skills 和结构化 MCP。页面通过共享 API 访问演示服务，业务记录与操作结果以接口返回为准。

实现分层：`routes.tsx` 以 `lazy` 加载 `RolesView.tsx`（`handle.nav = true` 注册一级导航），界面只负责渲染；全部业务规则（列表读取、草稿与基线、路由同步、字段校验顺序、保存载荷归一化、复制/删除后的导航与异步生命周期）集中在 `use-role-studio.ts` 的 `useRoleStudio`。读取走 `useResource`，写操作维护 `saving` / `copying` / `deleting` / `creating` 局部状态，失败文案经 `errorMessage` 归一。状态更新、地址跳转与通知都在卸载后被丢弃：钩子用 `activeRef` 与 generation 计数作废在途请求。

## 关键功能与验收

### 角色浏览与编辑工作室

通过 `/roles` 提供角色列表与编辑器，支持名称、描述和模型搜索，以及 `?id=` 详情定位。未指定角色时选择首条记录。

实现约定：地址栏是选中角色的唯一来源。带 `?id=` 时直接读取详情；未带 id 时默认选中首条记录且不改写地址。点击列表项、创建、复制、删除都以 `navigate(..., { replace: true })` 改写 `?id=`，再由路由同步 effect 落到 `/roles/:id`。已处理的 id 记录在 `handledRouteRef`，避免状态变动让同一次路由变化重复请求或重复确认。写结果以叠加层（`removed` / `changed`）作用在接口列表上，成功后不发第二次列表请求。界面使用 `.page-stack`、`.panel` 与网格列宽（窄屏单列、760px 起并排），列表容器是 `aside[aria-label="角色列表"]`。

#### 验收

- 列表显示角色名称、头像和模型，桌面并排显示列表与编辑器，窄屏上下排列且按钮不超出页面。
- 列表与详情有独立加载、失败重试和空状态，搜索无匹配时可清空条件。
- 详情通过 `/roles/:id` 获取并深拷贝到草稿，修改草稿不会提前改变列表中的已保存数据。
- 支持创建、保存、复制和确认删除。操作通过 `/roles`、`/roles/:id` 与 `/roles/:id/copy` 执行，成功后同步接口返回值。
- 被流程引用的角色删除失败时显示接口冲突原因（`role="alert"`），保留当前角色及草稿。

### 身份、提示词与能力配置

基本信息包括名称、描述、图标、标识颜色、执行器、连接引用与模型名称。Skills 使用共享 DTO 的 `{name, content}` 文本结构，MCP 使用 `{name, transport, command/url, credentialRef}` 结构。

实现约定：四个标签页用共享 `TabBar` 渲染（`Skills · n`、`MCP · n` 计数标签），表单控件用共享 `Input` / `Textarea` / `Select` 与原生 `label` 包裹，保持 `getByLabel` 语义。编辑一律经钩子导出的 `updateDraft` / `updateSkill` / `updateMcp` 等不可变更新函数，界面不直接改草稿对象。执行器与连接下拉切换后由 `changeConnection` 回填默认模型。

#### 验收

- 基本信息、系统提示词、Skills 和 MCP 分为四个标签页，切换标签保留编辑内容。
- 创建角色使用可用连接与初始提示词。未配置连接时提示前往连接管理，创建请求失败时保留输入。
- 选择连接后填入默认模型，模型允许修改。不存在的连接、空名称、空提示词等字段阻止保存并定位相应标签页。
- Skills 支持增删、名称与 Markdown 内容编辑，MCP 支持增删和 HTTP / stdio 选择，保存仅提交对应传输方式的地址或命令。
- Skills 和 MCP 检查必填字段与重复名称。HTTP 地址不接受内嵌认证信息、查询参数和片段。认证只填写凭据引用。
- 保存后刷新或重新打开，提示词、模型、Skills 和 MCP 与演示 API 的持久化结果一致。
- 复制使用已保存定义，未保存时提示先保存。副本具备独立标识，修改副本不影响原角色。

### 编辑保护与反馈

草稿与保存基线比较形成脏态，在保存栏与角色标题处显示状态。

实现约定：脏态由 `JSON.stringify(draft) !== baseline` 派生，未保存保护统一来自共享 `useUnsavedChanges`；创建弹窗的名称也计入脏态。切换角色（含浏览器历史只改查询串的情况）先 `await canLeave()`，取消时用 `replace` 把地址恢复到当前角色并保留草稿。保存栏显示 `有未保存的更改` / `所有更改已保存`。

#### 验收

- 修改后离开模块、切换角色、浏览器历史导航或放弃更改时请求确认，取消确认保留草稿。
- 浏览器关闭或刷新有未保存提醒，保存失败时保留草稿与错误原因。
- 保存、复制、删除请求进行时相关按钮禁用，避免重复提交，成功反馈在接口确认后显示。

## 模块职责与验收边界

- 本域页面（`RolesView.tsx`）、业务钩子（`use-role-studio.ts`）、草稿状态与路由归本目录，仅依赖 shared 公共 API、DTO、UI 与反馈能力。连接数据通过共享 API 查询，跨域跳转只用地址导航。
- 单元与组件测试使用 Vitest + Testing Library：`use-role-studio.test.tsx` 用 `renderHook` 包在 `createMemoryRouter` + `RouterProvider` 内，覆盖异步操作生命周期、深链接草稿隔离、切换确认、校验定位与删除失败；`RolesView.test.tsx` 覆盖列表/编辑器无障碍名称、标签页、保存状态与创建弹窗文案。
- 独立验收使用持久化 mock API，覆盖 CRUD、文本 Skills、MCP、深链接、脏态、复制隔离、删除冲突、加载与错误恢复。
- 演示 Skills 为文本内容，不包含真实服务规格中的嵌套文件包与内容寻址。完整文件包、路径校验、执行器能力判断需要按真实服务 DTO 联调。
- 联合验收连接真实 roles、connections、workflows、runs 与存储，验证事务引用约束、并发删除、旧运行快照隔离和凭据解析。mock 操作通过只证明页面与演示 API 的行为。
