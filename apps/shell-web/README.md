# 工作区入口

把多个模块组合进一个固定工作区的独立入口。组合关系全部在 `package.json` 与 `src/registry.tsx` 里显式声明：模块以 npm workspace 包或仓库内源码接入，宿主依赖它们并调用各自导出的模块工厂。当前接入 todo、fs、ssh、沙箱与 pi-web 五个模块。

## 页面结构

外壳固定为五块，宿主与模块都不改这个骨架：

- **标题栏** 40px：宿主标题、profile 切换器、设置与注册表入口。
- **侧边栏**：启用模块自上而下堆叠，每节可展开或折叠。展开的模块共享侧栏高度，折叠的模块只留一条横向窄条。
- **工作区**：只显示侧边栏处于展开态的模块，每个模块一列；选中设置或注册表时整块让给宿主页面。
- **控制面板**：按全局选中聚合模块声明的操作。
- **状态栏** 24px：左侧是展开模块的上下文信息，右侧是宿主状态。

## 页面 profile

profile 只声明启用哪些模块与顺序，不再描述区域布局：

| profile | 模块 |
| --- | --- |
| 工作（`work`） | todo、fs-web、ssh |
| 终端（`terminal`） | ssh、fs-web |
| 沙箱（`sandbox`） | 沙箱、ssh |
| 助手（`assistant`） | pi-web、fs-web |

默认只展开第一个模块；展开集合、每个模块的侧栏高度与工作区列宽按 `ursi.workspace:<profile>` 隔离持久化，当前 profile 存于 `ursi.workspace:profile`。切换 profile 会重挂布局表面，iframe 类模块（pi-web）会重载一次，属可接受的低频行为。

## 开发

```sh
npm install
npm run dev:shell-web        # http://localhost:5191
```

`vite.config.ts` 把 `/api` 代理到 todo-web 服务（默认 `http://127.0.0.1:8090`，可用 `TODO_WEB_API` 覆盖），把 `/api/fs-web` 代理到 fs-web（`FS_WEB_API`）、`/api/ssh-web` 代理到 ssh-web（`SSH_WEB_API`），把 `/sbx` 代理到沙箱控制台服务（`SBX_WEB_API`）。先启动对应后端：

```sh
cd apps/todo-web/server && cargo run        # 或已有实例
cd apps/fs-web/server && ...                # 8199
cd apps/ssh-web/server && ...               # 8091
```

## 模块怎么加

组合根 `src/registry.tsx` 是全应用唯一允许出现宿主胶水代码的地方：登记模块清单、注入模块 options（如 `apiBaseUrl`）、声明不占侧边栏的宿主页面，开发期校验模块 id 与 `context.kind` 全局唯一，撞名直接报错而不是被静默掩盖。

模块契约见 [`packages/workspace-shell/MODULE-CONTRACT.md`](../../packages/workspace-shell/MODULE-CONTRACT.md)。要点：

- 模块声明 `Sidebar`（`{ collapsed, collapse, expand }`）、`Workspace`（不含标题区）与 `context`（选中 kind、摘要、状态栏组件）。
- 需要跨侧边栏与工作区共享 React 上下文（拖拽、路由、controller）时声明 `Provider`，外壳会用同一个 Provider 包住三块内容。
- 侧边栏的折叠形态由模块渲染；外壳只提供 `SidebarFrame` 作为可选外框。

接入分三步：模块自己导出接入代码（如 `todo-web/web/src/module.tsx`），宿主 `package.json` 声明依赖，再在 `src/registry.tsx` 调用工厂并写进 profile。

## 标题栏与状态栏

设置页与注册表页不占侧边栏，注册到 `views` 后由标题栏按钮选中，占用整个工作区。

```tsx
<WorkspaceShell
  modules={modules}
  views={views}
  profiles={profiles}
  title="ursi workspace"
  settings={<SettingsButtons />}
  status="todo · 8090"
  storageKey="ursi.workspace"
/>
```

状态栏左侧来自展开模块的 `context`：声明了 `Status` 组件的模块常驻渲染，否则在选中属于该模块时显示 `summary`。

## 当前限制

- 宿主仍保留 `@/` 别名以编译 todo-web 源码（其内部导入约定）；模块协议稳定后再清理。
- todo 的样式表仍带 `:root` 变量命名（`--gray-*`），全局重置已移到独立入口的 `standalone.css`。
- 没有鉴权与路由。
