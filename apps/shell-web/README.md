# 工作区入口

把多个模块组合进一个工作区的独立入口。组合关系全部在 `package.json` 与 `src/registry.tsx` 里显式声明：模块以 npm workspace 包身份接入，宿主依赖它们并调用各自导出的模块工厂。当前接入 todo、fs、ssh、沙箱与 pi-web 五个模块，工作区区域与右侧操作栏按契约工作。

## 页面 profile

组合根声明三套内置 profile，标题栏下拉切换，布局按 profile 隔离持久化：

- **经典**（`classic`）：单横向区域平铺全部模块 + workspace + actions，与历史布局一致，直接复用 `ursi.workspace` 的存量布局数据。
- **开发**（`dev`）：三个区域，左侧任务与文件、中间终端与沙箱、右侧 pi-web 与工作区。
- **对话**（`chat`）：窄侧栏放 todo，主区放 pi-web + workspace + actions 纵向叠放。

当前选择存于 `ursi.workspace:profile`；各 profile 的布局与折叠状态存在 `ursi.workspace:<profileId>`。切换 profile 会重挂布局表面，iframe 类模块（pi-web）会重载一次，属可接受的低频行为。

## 开发

```sh
npm install
npm run dev:shell-web        # http://localhost:5191
```

`vite.config.ts` 把 `/api` 代理到 todo-web 服务（默认 `http://127.0.0.1:8090`，可用 `TODO_WEB_API` 覆盖），把 `/sbx` 代理到沙箱控制台服务（默认 `http://127.0.0.1:4180`，可用 `SBX_WEB_API` 覆盖，HTTP 与 WebSocket 同规则，代理层剥掉 `/sbx` 前缀）。先启动 todo-web 服务：

```sh
cd todo-web/server && cargo run          # 或已有实例
```

## 模块怎么加

组合根 `src/registry.tsx` 是全应用唯一允许出现宿主胶水代码的地方：登记模块清单（栏序即数组顺序）、注入模块 options（如 `apiBaseUrl`）、声明不占栏的视图，开发期校验模块 id 与 selection kind 全局唯一，撞名直接报错而不是被静默掩盖。

新模块的接入要求（契约、选中、折叠、样式作用域、副作用、交付物与检查清单）见 [`packages/workspace-shell/MODULE-CONTRACT.md`](../../packages/workspace-shell/MODULE-CONTRACT.md)。

接入分三步：模块自己导出接入代码（如 `todo-web/web` 的 `src/module.tsx` 与 `fs-web/web` 的 `src/module.tsx`），宿主 `package.json` 声明对它的依赖（`@ursi/todo-web`、`@ursi/fs-web`），再在 `src/registry.tsx` 的组合根里调用模块工厂：

外壳负责栏宽、折叠、选中与操作栏渲染，模块自己取数据。模块自带标题或工具条时可声明 `hideHeader: true`，外壳不再画标题行，折叠按钮移到分隔线中点。

折叠由外壳负责，模块只公布折叠时要展示的关键信息：实现 `useCollapsedSummary()` 返回 `{ title, items: [{ label, value }] }`，外壳负责排版（todo 公布当前任务标题、`status`、`project`，未选中时公布任务数）。模块内部需要更多宽度时用 `useModuleColumn().resize(px)` 自行请求，外壳不感知模块内部层级。

## 标题栏与状态栏

外壳自带 40px 标题栏与 24px 状态栏：标题栏左侧是 `title`，右侧放 `settings`；状态栏左侧显示当前选中摘要，右侧显示宿主传入的 `status`。两者固定高度，不参与拖拽。

设置页不占栏，注册到 `views` 后由标题栏按钮选中它：

```tsx
<WorkspaceShell
  modules={modules}
  views={views}
  title="ursi workspace"
  settings={<SettingsButton />}
  status="todo · 8090"
  storageKey="ursi.workspace"
/>
```

## 当前限制

- todo 接入代码已归位到 `todo-web/web/src/module.tsx`，宿主只调用工厂；内部的项目栏与任务栏还没拆成独立面板。
- 宿主仍保留 `@/` 别名以编译 todo-web 源码（其内部导入约定）；模块协议稳定后再按抽包清单彻底清理。
- 没有鉴权与路由。
