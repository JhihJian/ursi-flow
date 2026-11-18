---
parent: ../../SPEC.md
depends-on:
  - ../shared/SPEC.md
  - ../mocks/SPEC.md
  - ../modules/workflows/SPEC.md
  - ../modules/roles/SPEC.md
  - ../modules/runs/SPEC.md
  - ../modules/artifacts/SPEC.md
  - ../modules/sandboxes/SPEC.md
  - ../modules/connections/SPEC.md
  - ../modules/chat/SPEC.md
references:
  - ../../DESIGN.md
---

# Web App

## 功能意图

装配 React、React Router 数据路由、Zustand 与 API 模式，提供响应式应用壳、导航、主题、全局反馈和演示控制。七个业务域经公开路由接入，页面状态归所属业务域，模拟业务状态归 mocks，DTO 与通用控件归 shared。

入口为 `main.tsx`：挂载前同步执行 `theme.ts` 的 `initTheme()`，再按需注入模拟 transport，最后用 `router.tsx` 的 `createBrowserRouter` 渲染。应用壳为 `AppShell.tsx`，404 为 `NotFoundView.tsx`，按需加载失败提示为 `RouteErrorAlert.tsx`。

应用主题与基础控件复用并适配 Grasp，经 shadcn/ui（new-york 源码）落到 `shared/ui`，来源及许可证见 [第三方声明](../../THIRD_PARTY_NOTICES.md)。

## 关键功能与验收

### 启动与 API 模式

入口在挂载前应用主题并选择传输。默认 mock 模式注入应用 HTTP transport，live 模式使用同源网络 API。

#### 验收

- 默认启动可在 server 未运行时进入七域业务页，侧边栏工作区卡片显示“演示工作区”，并可打开演示设置。
- 注入模拟 API 后全局 fetch 保持原行为，业务请求通过 shared HTTP 入口处理。
- `VITE_API_MODE=live` 时显示真实服务模式标识并隐藏演示设置，网络错误保持请求失败，不回退 mock。
- 默认构建包含演示能力，`build:live` 使用 live 模式并排除模拟 API。独立验收确认模式与资源选择，真实 API 协议仍需联调。

### 七域路由与错误恢复

路由表由 `router.tsx` 聚合各域导出的 `routes.tsx`（React Router `RouteObject`），首页重定向到工作流。`/`、`/workflows`、`/roles`、`/runs`、`/artifacts`、`/sandboxes`、`/connections`、`/chat` 均为懒加载，详情页有独立地址。路由 `handle.title` 决定 `document.title` 与面包屑。

#### 验收

- 直接进入七个一级地址显示对应业务页，`document.title` 为 `${title} · ursi-flow`。
- `/runs/:id` 展示指定运行并高亮运行导航，刷新保持深链，根地址进入工作流。
- 一级页面导航通过 `aria-current` 标记当前页，详情页由高亮和面包屑标记所属域。未知页面显示“页面未找到”并可返回工作流。
- 业务域资源加载失败时保留应用壳与失败地址，恢复后可重新打开目标；正常导航后错误消失。
- 独立浏览器验收检查路由行为，生产 history 回退与 `/api`、静态资源错误隔离由真实托管环境联合验收。

### 响应式应用壳、主题与键盘

小屏通过吸顶顶栏的菜单按钮打开 `sheet.tsx` 的左侧抽屉（标题“工作区导航”），顶栏只在小于 1024px 时存在，提供抽屉入口与所属域面包屑。桌面不渲染顶栏，导航与位置提示由侧边导航和页面标题承担。桌面（≥1024px）壳层锁定视口高度：侧边导航不动，`.shell-scroll` 单独承载内容区滚动，`.shell-content` 宽度上限 1920px，`.page-stack` 至少填满内容区。需要满高面板的页面追加 `.page-stack-fill`，滚动落在面板内部（列表、编辑区或消息区），页面本身不滚动。演示工作区与真实服务标识位于侧边导航底部的工作区卡片。亮色为默认主题，主题偏好在挂载前读取并保存到独立 localStorage 键 `ursi-flow:theme`，`storage` 事件同步其他标签页。深色同时写 `data-theme="dark"` 与 `.dark`。

#### 验收

- 桌面与移动浏览器均可操作七域入口，导航成功后抽屉关闭，内容区保持窄屏可读；桌面无顶栏，移动端顶栏在滚动时保持吸顶。
- 桌面内容区填满视口，页面高度不足一屏时面板延伸到内容区底部，内容超过一屏时才出现滚动条；窄屏保持文档滚动，内容不被裁切且无横向溢出。
- 切换主题后背景、文本与控件同步变化，刷新后保留选择；存储访问受限时仍可在当前页面切换。
- 首次 Tab 聚焦“跳到主要内容”，激活后焦点进入主内容区，导航与错误恢复按钮可通过键盘操作。
- 抽屉和弹窗约束焦点，关闭后恢复焦点，Esc 只关闭顶层弹窗。相关交互通过组件与浏览器独立验收。

### 演示控制与全局反馈

应用壳展示 shared 反馈 store 的确认和通知状态，通过模拟 API 加载设置、调整延迟与一次性故障并重置数据。

#### 验收

- 打开演示设置时显示加载态，失败可重试；只有成功读取设置后才能保存。
- 请求延迟允许 0 至 30000ms，非法值显示原因；设置一次性故障后，下一个业务请求返回模拟错误，重试恢复。
- 设置与重置接口不消费一次性故障；运行详情的自动轮询可作为下一个业务请求消费开关。
- 重置要求确认，取消保持数据，确认成功后恢复初始演示状态并重新加载页面。
- 操作通知可关闭，确认弹窗支持取消与提交，写请求进行时显示等待状态。模拟控制独立验收使用 mocks，live 模式业务错误由各域与真实 API 联合验收。

## 交付与验收边界

独立验收通过 React Router 内存路由与 Testing Library 组件测试、默认构建及桌面和移动 Playwright 覆盖装配、导航、主题、演示控制、键盘与加载失败恢复。主题与反馈状态由 Zustand store 独立测试。业务操作及其状态规则由七域和 mocks 规格定义。

真实服务接入需使用 live 模式联调同源 `/api` 的路由、DTO、认证与响应。生产静态托管及真实运行、资源和产物另按 [总体设计](../../DESIGN.md) 的联合边界验收。
