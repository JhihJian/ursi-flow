# 工作区外壳与模块组合

目标是让「任务看板」这类模块能被组合进同一个工作区：每个模块占一栏、可折叠，共享一块工作区区域，选中状态集中管理，右侧放上下文操作。这份文档只定契约与推进节奏，不引入运行时代码。

## 结论

方向对，但**现在不抽包**。仓库现状是只有一个真实模块（todo-web），执行与运行详情还是外部产品。先按这套契约在 todo-web 内部把「栏」和「选中」拆出来，等第二个真实模块出现，再把内部实现提升为 `packages/workspace-shell`。提前做通用外壳，会得到一套没有第二个使用者的抽象。

外壳与模块的分工：

| 能力 | 归属 |
| --- | --- |
| 分栏布局、宽度、折叠、窄条 | 外壳 |
| 全局选中（选中的任务、运行、会话） | 外壳的选择总线 |
| 工作区区域渲染哪个视图 | 外壳按选中类型分派 |
| 右侧上下文操作面板的骨架 | 外壳 |
| 具体数据、请求、字段、业务动作 | 各模块 |
| 操作项（如「执行这个任务」）的声明与实现 | 模块注册，外壳只渲染 |

## 契约

### 面板

```ts
interface PanelContribution {
  id: string                         // 全局唯一，用于持久化宽度与折叠状态
  title: string
  order: number
  Component: React.ComponentType      // 展开态内容，自带数据获取
  Rail?: React.ComponentType<{ onExpand: () => void }>  // 折叠态窄条，缺省用 title
  defaultSize?: number
  minSize?: number
  collapsible?: boolean
  keepMounted?: boolean               // 折叠时不卸载，保留内部状态
}
```

外壳负责 `react-resizable-panels` 的 Group/Panel、折叠到 32px、宽度记忆。模块不接触布局。

### 选中

```ts
type Selection = { kind: string; id: string; label?: string } | null

interface SelectionKind {
  kind: string                       // 例如 'todo.task'、'run.attempt'
  summary: (selection: Selection) => string   // 窄条与工作区标题用
  workspaceView?: React.ComponentType<{ selection: Selection }>
}

useWorkspaceShell().select({ kind: 'todo.task', id })
```

规则：

- 全局只有一个选中；模块内部不要另存一份「当前选中任务」。
- 选中只存 `kind + id`，实体由模块按 id 自己取，避免跨模块传对象。
- 工作区区域由外壳按 `kind` 找 `workspaceView`；没有匹配视图时显示占位说明（现在就是这么做的）。

### 操作

```ts
interface ActionContribution {
  id: string
  label: string
  group?: 'primary' | 'secondary'
  appliesTo: (selection: Selection) => boolean
  run: (selection: Selection) => Promise<void>
  disabledReason?: (selection: Selection) => string | null
}
```

「基于某个任务运行执行器」是 todo 模块（或未来的执行模块）注册的一项操作，外壳不认领域概念。这样右侧面板不用改代码就能多出别的操作，例如「打开会话」「复制 Markdown」。

### 工作区视图

```ts
interface WorkspaceViewContribution {
  id: string
  matches: (selection: Selection) => boolean
  Component: React.ComponentType<{ selection: Selection }>
}
```

已有的 `workspace-config.json` + iframe 是其中一种实现：`matches` 判断选中的是任务且填了 workdir/session，`Component` 渲染 iframe。别的方式（源码组件、自有页面）注册另一种视图即可，外壳不需要区分。

## 现在就在 todo-web 里做的三步

1. 把 `Workspace.tsx` 里的三栏改成数据驱动：模块内维护一份 `panels[]` 常量喂给外壳组件，外壳组件仍放在 `todo-web/web/src`，不发布成包。
2. 把「当前选中任务」从 `detail` 里拆出来，进 `selection`（`{kind: 'todo.task', id}`），详情面板、活动栏、工作区都从 `selection` 读，去掉重复的真值。
3. 把复制 Markdown、折叠工作区、未来的「执行」写成 `actions[]`，右侧面板按 `appliesTo` 渲染。

三条都做在同一份代码里，接口形状与将来抽包一致，届时是搬运而不是重写。

## 抽包的门槛

满足其中一条再动：

- 出现第二个真实模块（例如运行记录、会话查看）并且确实要和任务并排。
- 有宿主项目要把这些栏嵌进自己的布局，而不是链接过去。

抽包时按上一份文档的清单清理：`@/` 别名、全局 CSS 重置、单例 store、全局 `keydown`、`alert/prompt`、硬编码 `/api` 与配置文件路径；`react`/`react-dom` 转 peerDependencies；宿主设置 `dedupe` 与 `ursi-source` 条件。样式统一挂容器类并用 `@layer`，必要时 Shadow DOM。

## 与现有包的关系

`packages/ui-slots` 提供的是「按位置注册贡献」的原语（`createSlotRegistry`），外壳的面板、操作、工作区视图都可以复用它，不必另写注册表；`packages/ui-layout` 负责页面骨架（header/main/aside），外壳是它内部的一块。三者职责不重叠：`ui-layout` 管页面，`workspace-shell` 管栏，`ui-slots` 管贡献注册。

## 不做的

- 不做运行时插件加载、动态 import 远程包、微前端框架。模块仍是构建期登记，和门户插件现在的做法一致。
- 不让每个模块自带路由；地址由宿主决定，模块只接收选中。
- 不让外壳认识任务、运行、会话这些领域概念，也不让它发请求。
- 不在现在抽 `packages/workspace-shell`。
