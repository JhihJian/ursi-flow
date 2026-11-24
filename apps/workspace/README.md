# 工作区入口

把多个模块组合进一个工作区的独立入口。第一版只接入 todo 模块，工作区区域与右侧操作栏已按契约工作。

## 开发

```sh
npm install
npm run dev:workspace        # http://localhost:5191
```

`vite.config.ts` 把 `/api` 与 `/workspace-config.json` 代理到 todo-web 服务（默认 `http://127.0.0.1:8090`，可用 `TODO_WEB_API` 覆盖）。先启动 todo-web 服务：

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

外壳负责栏宽、折叠、选中与操作栏渲染，模块自己取数据。契约见 `packages/workspace-shell/src/contracts.ts`。

## 顶部与底部横栏

`WorkspaceShell` 的 `top` 与 `bottom` 各接一个 `{ title, content, defaultSize }`，现在放的是占位文案：顶部留给全局工具条，底部留给执行输出。横栏可拖动分隔线改高，也能折叠成 28px 摘要条。

```tsx
<WorkspaceShell modules={modules} top={toolbar} bottom={output} storageKey="ursi.workspace" />
```

## 当前限制

- todo 仍整栏挂载（`apps/workspace/src/modules/todo.tsx`），内部三栏还没拆成独立面板。
- 用 `@todo` 别名直接编译 todo-web 源码，并复用其 `styles.css`；等模块协议稳定再抽成独立包。
- 没有鉴权与路由。
