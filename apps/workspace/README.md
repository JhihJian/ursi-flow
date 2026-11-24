# 工作区入口

把多个模块组合进一个工作区的独立入口。第一版只接入 todo 模块，工作区区域与右侧操作栏已按契约工作。

## 开发

```sh
npm install
npm run dev:workspace        # http://localhost:5191
```

`vite.config.ts` 把 `/api` 代理到 todo-web 服务（默认 `http://127.0.0.1:8090`，可用 `TODO_WEB_API` 覆盖）。先启动 todo-web 服务：

```sh
cd todo-web/server && cargo run          # 或已有实例
```

## 模块怎么加

在 `src/App.tsx` 的 `modules` 数组里加一项 `WorkspaceModule`：

```ts
{
  id: 'runs', title: 'Runs', Panel: RunsPanel,
  selection: { kind: 'run.attempt', summary, WorkspaceView },
  actions: [{ id: 'cancel', label: 'Cancel run', appliesTo, run }],
}
```

外壳负责栏宽、折叠、选中与操作栏渲染，模块自己取数据。模块自带标题或工具条时可声明 `hideHeader: true`，外壳不再画标题行，折叠按钮移到分隔线中点。

折叠成什么样子由模块决定：声明 `collapsedSize` 与 `Rail`，外壳在折叠时只渲染这个 `Rail`（todo 用的是书脊式任务摘要）。模块内部需要更多宽度时用 `useModuleColumn().resize(px)` 自行请求，外壳不感知模块内部层级。

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

- todo 仍整栏挂载（`apps/workspace/src/modules/todo.tsx`），内部的项目栏与任务栏还没拆成独立面板。
- 用 `@todo` 别名直接编译 todo-web 源码，并复用其 `styles.css`；等模块协议稳定再抽成独立包。
- 没有鉴权与路由。
