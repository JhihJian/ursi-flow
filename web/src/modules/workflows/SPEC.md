---
parent: ../../../SPEC.md
depends-on:
  - ../../shared/SPEC.md
  - ../../../../server/src/workflows/SPEC.md
references:
  - ../../../DESIGN.md
---

# 工作流前端模块

## 功能意图

为流程维护者提供紧凑的流程目录、定义编辑、只读依赖图和运行发起入口。工作流与角色从共享 API 读取，结构校验在编辑时提供反馈，引用一致性与最终保存结果由服务端确认。

## 关键功能与验收

### 目录、详情与定义管理

`/workflows` 通过 `routes.tsx` 的 `lazy` 加载 `WorkflowsView.tsx`，以路由 `handle.nav = true` 注册一级导航。目录提供搜索、创建、编辑、复制和删除，点击名称读取定义详情。

实现约定：页面状态由组件局部 `useState` 管理，列表读取走 `useResource`（保留 generation 与 AbortController 语义），写操作自行维护 `savingId` / `actionError`。复制与删除使用共享 `confirmAction`，成功提示使用 `notify`，错误经 `errorMessage` 归一。列表使用 `.page-stack`、`.toolbar`、`.table-wrap`、`.data-table` 等既有类名；桌面页面取 `.page-stack-fill`，表格占据剩余高度并在 `.table-fill` 内滚动，表头固定。

#### 验收

- `GET /workflows` 返回的名称、描述、节点数与更新时间显示在目录，搜索匹配名称或描述。加载、空目录、无匹配和请求失败均有可操作提示。
- 桌面目录表格填满内容区剩余高度，行数超过可视区域时在表格内滚动且表头保持可见；窄屏保持文档滚动。
- `GET /workflows/:id` 返回详情后，可查看描述、节点依赖与角色引用。详情请求失败可重试。
- 新建与编辑分别向 `POST /workflows`、`PUT /workflows/:id` 提交名称、描述、nodes、edges，成功后重新读取目录。
- 复制确认后请求 `POST /workflows/:id/copy` 并打开副本编辑。删除确认后请求 `DELETE /workflows/:id`，失败保留原记录并显示错误。
- 所有写操作防止重复提交，失败保留可修正的输入，关闭脏表单、离开路由或刷新页面提示未保存更改。

### JSON 编辑与只读依赖图

名称、描述配合节点与连线 JSON 编辑，使用角色下拉创建节点。只读图直接由定义中的节点、边生成，支持选择节点查看配置。

实现约定：`WorkflowEditor.tsx` 使用共享 `Modal` 与原生控件封装（`Input`、`Textarea`、`Select`），未保存保护来自 `useUnsavedChanges`，关闭按钮先 `await canLeave()`。结构校验集中在 `definition.ts` 的 `parseDefinition`（纯函数，文案固定），`nodeTypeLabel` 与 `formatTime` 同文件导出。`WorkflowDiagram.tsx` 以固定分层算法计算坐标并渲染内联 SVG，不依赖外部画布库。

#### 验收

- `GET /roles` 提供角色名称与标识，添加 agent 节点使用选定角色或第一个可用角色。角色加载失败可重试，未加载成功时禁止保存。
- JSON 可独立格式化。校验检查名称、非空节点数组、节点标识和名称、类型、角色、脚本、连线端点、重复边及无环结构，错误可定位到字段或节点。
- agent、approval、script 节点有文字类型标记，分支与汇合按依赖分列。点击节点显示标识、角色、脚本及直接上游信息。
- 流程图在窄屏可水平滚动，不通过拖动修改定义，不依赖外部画布库。

### 发起运行

用户从工作流输入任务，可附带运行名称。创建响应决定后续导航与显示结果。

实现约定：`RunLaunchModal.tsx` 使用共享 `Modal`，以 `#launch-run` 表单提交；必填校验错误用 `role="alert"` 呈现。成功后写入 `launched` ref 使离开保护失效，再关闭弹窗并 `navigate('/runs/:id')`；卸载后迟到的响应不得再触发状态更新、关闭事件或导航。

#### 验收

- 任务输入必填，`POST /runs` 提交 `{ workflowId, input, name? }`。
- 创建成功后依据返回的运行标识进入 `/runs/:id`，失败时保留输入、工作流上下文与错误。
- 请求进行时禁止重复创建，取消填写时保护未提交内容。

## 模块职责与验收边界

- 本域拥有页面、表单校验、只读图和本域路由。共享层提供 DTO、请求、反馈与基础 UI，跨域通过地址导航。
- 单元与组件测试使用 Vitest + Testing Library：`definition.test.ts` 覆盖纯校验，`WorkflowsView.test.tsx` 与 `RunLaunchModal.test.tsx` 用 `createMemoryRouter` + `RouterProvider` 覆盖目录、编辑、离开保护、运行创建与异步生命周期。
- Mock 独立验收使用演示 API 或接口替身覆盖 CRUD、角色选择、非法定义、错误恢复、复制删除确认、运行创建和跳转。结果证明前端请求响应行为与模拟闭环。
- 真实联合验收连接 workflows、roles、runs、transport 与存储，检查角色引用、并发编辑、删除冲突、完整读回及新旧运行快照隔离。
- Mock 创建运行不代表真实模型、脚本或 CLI 已执行。真实执行链路、沙箱准备和产物交付由运行域联合验收提供证据。
