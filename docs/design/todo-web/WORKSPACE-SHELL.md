---
parent: ../..
references:
  - ../../../packages/workspace-shell/SPEC.md
  - ../../../packages/workspace-shell/MODULE-CONTRACT.md
---

# 工作区外壳与模块组合

工作区外壳把 todo、文件、终端、沙箱与 pi 系列模块组合到一个固定页面里。本文记录当前结构与决定；契约为准的验收条件见 [外壳 SPEC](../../../packages/workspace-shell/SPEC.md) 与 [模块接入规范](../../../packages/workspace-shell/MODULE-CONTRACT.md)。

## 结论

页面骨架固定，模块只声明侧边栏、工作区与上下文。

早先版本按「一模块一栏」横向平铺，栏宽下限之和超过 1920px 屏宽，于是加了 profile 与区域声明。结果是 profile 承担了布局细节，页面结构继续发散。现在改为固定五区：

| 区域 | 归属 |
| --- | --- |
| 标题栏、状态栏 | 外壳 |
| 侧边栏堆叠、手风琴展开与展开项持久化 | 外壳 |
| 工作区单列渲染 | 外壳 |
| 右侧控制面板骨架与操作执行 | 外壳，操作由模块声明 |
| 侧边栏内容与折叠形态 | 模块 |
| 工作区内容 | 模块 |
| 选中、状态栏信息 | 模块发布，外壳展示 |

## 模块声明

```ts
interface WorkspaceModule {
  id: string
  title: string
  Provider?: React.ComponentType<{ children: React.ReactNode }> // 纯上下文
  Sidebar: React.ComponentType<{ collapsed: boolean; collapse: () => void; expand: () => void }>
  Workspace: React.ComponentType
  context: {
    kind?: string
    summary?: (selection: Selection) => string
    Status?: React.ComponentType
  }
  collapsedSidebarSize?: number
  defaultExpanded?: boolean
  keepMounted?: boolean
  actions?: WorkspaceAction[]
}
```

profile 只剩 `{ id, title, modules: string[] }`：启用哪些模块、按什么顺序堆叠。

## 关键实现

- **跨区域上下文。** 侧边栏与工作区在 DOM 上分开，但模块只挂载一次：外壳用 `ModuleHost` 在侧边栏面板里声明模块的 `Provider`，再通过 portal 把 `Sidebar`、`Workspace`、`Status` 投递到三个区域。同一模块的三块内容共享 React 上下文，todo 的 `DndContext`、沙箱的 `MemoryRouter`、ssh 的 controller 都靠这条路径工作。
- **堆叠侧边栏是手风琴。** 同一时刻只有一个模块展开并占满侧栏高度，其余模块压成 32px 横向窄条；折叠方向是上下，按钮用 ↑ / ↓。展开项只存一个模块 id，不需要分高度、也没有节间拖拽条。
- **工作区只看展开态。** 展开的那个模块占满工作区；折叠即移除（`keepMounted` 的模块改投隐藏槽位，iframe 与终端不重置）。设置、注册表这类宿主页面通过 `views` 注册，选中时占用整个工作区。
- **状态栏由模块提供。** 展开模块声明 `context.Status` 时外壳给它留槽位；否则在选中属于该模块时显示 `summary`。
- **持久化。** 展开项 `${storageKey}:<profile>:expanded`（单个模块 id，全部折叠时不写）；当前 profile 存于 `${storageKey}:profile`。

## 已否决的方案

- **继续按 profile 声明区域与条目。** 布局细节压在 profile 里，新增模块要改 profile 的每个变体；固定骨架后 profile 只做启用与排序。
- **模块自绘整块三栏布局。** 每个模块都要重新实现折叠、工作区、操作栏，页面风格无法统一。
- **折叠摘要由外壳排版（旧契约）。** 不同模块要展示的信息差异太大，外壳排版只能做成最小公倍数；现在折叠形态归模块，外壳提供 `SidebarFrame` 作为可选外框。
- **工作区多列并排。** 多列同时展开时总宽容易超过屏幕，还得由用户自己决定折叠谁；改成侧边栏手风琴后，工作区永远只有一列，宽窄只由控制面板决定。

## 已知缺口

- todo 的样式表仍带 `:root` 变量（`--gray-*`），全局重置已移到独立入口的 `standalone.css`，但变量命名尚未加前缀。
- 沙箱暂不发布选中，实例导航由路由承担；跨模块操作出现时再注册 `sandbox.instance` 与 `actions`。
- 手风琴下跨模块协作要来回切换：在任务里选中一项、执行「在文件模块打开项目目录」后，任务侧边栏会收起。侧边栏状态由各模块自己保持，切回来不会丢。
