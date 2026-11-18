---
parent: ../../SPEC.md
references:
  - ../../DESIGN.md
---

# Web Shared

## 功能意图

为七个业务域提供共用 DTO、API 请求、通用控件、请求生命周期、编辑保护及反馈。共享层保持独立，业务页面与交互状态归各域，模拟调度与持久化归 mocks。

技术栈为 React 19 + TypeScript、Zustand 与 Tailwind 3。通用控件以 shadcn/ui（new-york 源码）为基础，vendored 在 `ui/`，依赖 `@radix-ui/*`、`class-variance-authority`、`clsx`、`tailwind-merge`；图标继续使用本地 `icons/` 目录。来源及许可证见 [第三方声明](../../THIRD_PARTY_NOTICES.md)。

目录职责：

- `api/`：DTO 与 `api.get/post/put/delete` 入口。
- `http/client.ts`：同源请求、错误白名单与可注入 transport，另导出 `getApiTransport()` 供流式读取复用。
- `hooks/use-resource.ts`、`hooks/use-unsaved-changes.ts`：资源加载与编辑保护。
- `stores/feedback.ts`：Zustand `useFeedbackStore`（通知与确认）。
- `lib/utils.ts`：`cn()` 类名合并。
- `ui/`：基础控件。

## 关键功能与验收

### 共用 DTO 与 API 入口

`api/types.ts` 定义角色、连接、流程、运行、事件、快照、产物、沙箱以及对话会话与消息的共用传输结构。API 入口提供 GET、POST、PUT、DELETE，页面与模拟后端使用同一套 DTO。

#### 验收

- 七域通过共享 DTO 与 API 编译检查，业务模块通过标识查询关联资源，共享层不导入 app 或业务域实现。
- POST 和 PUT 发送 JSON 内容，成功响应保留原结构，DELETE 接受 204，要求有正文的 API 调用收到空响应时报错。
- 演示产物包含运行、节点与运行级轮次，运行响应含冻结配置及事件；真实 server 的 generation、节点 attempt、完整 Skill 文件包等协议另行联调。
- 独立验收使用模拟 API 或请求替身检查方法、路径、内容与响应处理，真实 DTO 和认证通过 server transport 联合验收。

### 同源请求与可注入传输

HTTP 层统一使用 `/api` 前缀和同源凭据策略，保留调用方请求参数、JSON 结构及取消信号。入口可注入模拟 transport，默认 transport 调用浏览器 fetch。

#### 验收

- 单个 `/` 开头的路径形成同源 `/api` 请求，绝对 URL 与 `//` 地址被拒绝。
- 注入 transport 后只有应用 API 入口使用该实现，全局 fetch 保持原行为，live 网络错误不触发模拟回退。
- 请求透传 AbortSignal，取消保持 AbortError，204 返回空值；非 JSON 成功响应和损坏 JSON 返回固定可识别错误。
- HTTP 失败保留状态码，白名单错误码映射为可读提示；包含标记密钥的上游错误正文不进入对外错误信息。
- 请求层本身不写入浏览器持久存储。独立测试验证上述传输行为，真实状态码和响应格式另与 transport 联合验收。

### 通用控件与资源状态

`ui/` 提供 `button`（含 primary/subtle/danger 别名、icon/loading/block）、`modal`、`sheet`、`tabs`（含兼容用法的 `TabBar`）、`switch`、`badge`（含 `StatusPill`）、`input`、`textarea`、`label`、`select`、`card`、`alert`、`table`、`skeleton`、`scroll-area`、`separator`、`tooltip`、`dropdown-menu`、`avatar`，以及 `icon`、`spinner`、`markdown-content`、`page-header`、`resource-state`、`shell-sidebar`、`status-pill`，供 app 与业务域组合。控件默认套用 `styles.css` 的组件类与语义 token，视觉与旧实现一致。

#### 验收

- 加载、错误及空结果可区分，错误可触发调用方重试，等待中的按钮展示加载并阻止重复操作。
- 模态框打开后约束键盘焦点，支持 Esc 和关闭后焦点恢复；多层弹窗叠开时只有顶层响应 Esc 与遮罩关闭。
- 标签页支持方向键、Home、End，开关具有可读状态，控件在亮暗主题和窄屏下可操作。
- 按钮、模态框与状态标签的文案、类名与无障碍名称与迁移前一致，浏览器验收的定位器无需改写。
- 通过组件测试与七域浏览器操作独立检查呈现和交互，真实服务状态映射由使用方联合验收。

### 请求生命周期、编辑保护与反馈

`hooks/use-resource.ts` 保留上次成功数据，用取消信号与请求版本隔离旧响应。`hooks/use-unsaved-changes.ts` 根据业务草稿状态确认离开。`stores/feedback.ts` 提供全局通知与确认，由 app 呈现。

#### 验收

- 重复加载取消旧请求，旧响应不能覆盖新结果；作用域释放取消在途请求。
- 请求失败给出可重试错误，取消请求不作为业务失败展示。
- 未保存时离开页面或刷新可提示，取消离开保留草稿，保存基线更新后清除脏态。
- 确认操作返回用户选择，通知可关闭，成功反馈由业务域在接口确认后触发。
- 独立验收使用延迟与失败替身检查清理、竞态和草稿保留，真实写入结果及冲突由业务域联合验收。

### Markdown 净化展示

文本由 marked 解析，再经 DOMPurify 净化后渲染为全局 `.markdown-content` 规则，供产物与对话消息等场景显示 Markdown 内容。

#### 验收

- 标题、列表、代码、引用和表格保持可读结构，长文本与宽表格在容器内展示。
- 预览仅允许 Markdown 排版所需的 HTML 标签和属性。脚本、事件属性、危险链接、内联样式、iframe、表单、图片、SVG 和媒体元素被移除，避免预览内容自动加载外部资源。
- 源文件和 Blob 下载由产物域使用原始内容完成，净化只影响 HTML 预览。
- 独立组件测试检查净化结果，浏览器验收检查模拟 API 内容的预览；真实产物授权、回收及字节完整性由 artifacts 联合验收。
