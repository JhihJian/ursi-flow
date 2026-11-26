# 子模块接入规范

给 `shell-web` 写模块时按这份规范做。外壳固定为「标题栏 / 堆叠侧边栏 / 工作区 / 控制面板 / 状态栏」，模块只声明三块内容：侧边栏、工作区、上下文。

## 1. 导出一个模块对象

```tsx
import type { ModuleSidebarProps, WorkspaceModule } from '@ursi/workspace-shell'

export function createExecutorModule(): WorkspaceModule {
  return {
    id: 'executor',                        // 小写短横线，全局唯一，用于持久化键
    title: 'Executor',
    Provider: ExecutorProvider,            // 可选：包住侧边栏 / 工作区 / 状态栏的纯上下文根
    Sidebar: ExecutorSidebar,              // ({ collapsed, collapse, expand }) => UI
    Workspace: ExecutorWorkspace,          // 工作区内容，不带模块标题区
    context: {
      kind: 'run.attempt',                 // 本模块发布的选中类型
      summary: (selection) => selection.label ?? selection.id,
      Status: ExecutorStatus,              // 可选：状态栏组件
    },
    sidebarDefaultSize: 280,
    sidebarMinSize: 160,
    sidebarMaxSize: 560,
    collapsedSidebarSize: 32,
    keepMounted: false,
    actions: [...],
  }
}
```

必填只有 `id`、`title`、`Sidebar`、`Workspace`、`context`。

## 2. 侧边栏：两种形态都由模块渲染

- `Sidebar` 收到 `{ collapsed, collapse, expand }`。折叠时渲染一条横向窄条，展开时渲染完整内容。
- 窄条上给出标题与 2–3 项关键信息（状态、数量），整条可点击展开，并带 `aria-label`。
- 折叠态不要依赖折叠时的高度值，外壳会把这一节压到 `collapsedSidebarSize`（缺省 32px）。
- 可以用外壳导出的 `SidebarFrame` 省掉重复的标题行与窄条：

```tsx
<SidebarFrame
  title="文件"
  collapsed={collapsed}
  collapse={collapse}
  expand={expand}
  items={[{ label: '打开', value: String(open) }]}
>
  <FileExplorer />
</SidebarFrame>
```

- 侧边栏内部可以有自己的二级折叠（例如文件目录列表），但不要再嵌套可拖拽的整页分栏。
- 不要在工作区重复放模块标题。

## 3. 工作区：只放内容

- `Workspace` 是模块的主体，不含标题区、不含「折叠 / 展开」入口。
- 工作区只在侧边栏展开时显示。声明 `keepMounted: true` 时折叠后仍挂载（隐藏），适合 iframe、终端这类不能重置的模块；否则折叠即卸载，重新展开从头开始。
- 不要假设工作区一定有确定宽度：多模块同时展开时一列可能只有 300–500px。用 `flex`、`min-width: 0`，表格允许横向滚动或收列。
- 滚动放在模块自己的容器上，不要让整页滚动。

## 4. 上下文：选中与状态栏

- 选中发布到外壳唯一那份：`useWorkspace().select({ kind, id, label })`。
- `context.kind` 必须是全局唯一的类型名，形如 `<域>.<实体>`。多个模块不能声明同一个 kind。
- 只传 `kind` 与 `id`，实体由模块按 id 自取；不要把对象塞进选中里。
- 模块内部不要再维护一份「当前选中」并双写。
- 清空时只清除属于自己 kind 的选中，避免模块挂载时抹掉别的模块的选择。
- `context.summary(selection)` 用于状态栏与控制面板的摘要；`context.Status` 是可选的状态栏组件，侧边栏展开时外壳为它留槽位并渲染。

## 5. Provider：跨区域的共享状态

- 侧边栏和工作区在 DOM 上是分开的两块，但外壳会把同一个 `Provider` 包住二者（通过 portal 保留上下文）。
- `Provider` 只放纯上下文：`DndContext`、`MemoryRouter`、controller provider、数据 provider。不得渲染布局 DOM（`<div className="x-app">` 会落到侧边栏面板里）。
- 需要样式作用域时，在 `Sidebar` 和 `Workspace` 内部各包一层模块根类，不要指望 `Provider` 提供 DOM。
- 浮层容器（右键菜单、Radix Portal 目标）按区域各建一份：侧边栏里的菜单挂侧边栏容器，工作区里的浮层挂工作区容器。

## 6. 样式：进容器作用域

- 所有模块样式挂模块根类（如 `.executor-app`），变量挂在该容器上。
- 禁止写 `html`、`body`、`:root`、`#root`、全局 `*` 重置。独立入口需要时另建 `standalone.css`，只在独立入口导入。
- 避免 `position: fixed`；需要浮层时用 `position: absolute` 挂在模块容器内。
- 视觉沿用外壳的灰度、衬线标题 + 等宽数据；不要引入彩色主题。

## 7. 副作用：可关闭、可注入

- 接口地址由宿主注入（`apiBaseUrl`），不要硬编码 `/api`。
- 轮询、通知、声音、桌面通知这类全局行为要有开关，默认在嵌入模式下关闭。
- `window` 上的键盘监听要么挂容器，要么在失焦/卸载时移除；不要抢占宿主的 `Esc`。
- 不要用 `alert` / `prompt` / `confirm`；错误交给 `onNotify`（或控制面板的错误位）展示。
- `localStorage` 键加模块前缀（`executor.xxx`），并允许宿主注入 `storageKey`，避免两个实例互相覆盖。

## 8. 跨模块：能力由工厂导出，组合根注入

一个模块不能读另一个模块的 store，也不能拿另一个模块的数据去调它的内部 API。跨模块流程一律走这条路径：

1. **接收方导出具名命令。** 工厂返回 `{ ...module, commands }`，命令只接受普通值（路径、字符串），自行校验并返回普通值或引用，绝不返回实体、store 或 API 对象。
2. **发送方只声明它需要的形状。** `createTodoModule({ openRootInFiles })` 里的 `openRootInFiles` 是一个函数类型，todo 不 import 文件模块的任何东西。
3. **组合根接线。** `registry.tsx` 同时拿到两个工厂，把接收方的命令传给发送方。删掉接收方会直接编译失败，不会留到运行期才发现。
4. **导航用 `ShellHandle`。** 操作回调收到 `shell`：`shell.enabled(moduleId)` 判断接收方是否在当前 profile 启用（据此写 `disabledReason`），`shell.reveal(moduleId)` 展开接收方侧边栏并退回模块视图。

```tsx
// 组合根
const files = createFsModule({ apiBaseUrl: '/api/fs-web' })
const todo = createTodoModule({ openRootInFiles: files.commands.openRoot })

// 发送方的操作
disabledReason: (_selection, shell) =>
  shell.enabled('fs-web') ? null : '文件模块未在当前 profile 中启用',
run: async (selection, shell) => {
  await openRootInFiles(projectPath)
  shell.reveal('fs-web')
},
```

约束：

- 跨模块传递的只有**普通值**。接收方把参数当作不可信输入：按 id 的，id 必须先在它自己的可见清单里；按路径的，必须校验并让用户在该操作的 `confirm` 里看到实际路径。
- 会改变接收方持久状态的命令（例如登记目录）必须由调用方声明 `confirm`，确认文案用函数形式带出实际参数。
- 禁止用事件总线或字符串意图名代替这条边：那样在 import 图里看不见依赖，删模块只有运行期才炸。

## 9. 操作：注册，不自造按钮

- 「执行」「取消」「打开会话」这类动作注册成 `actions[]`，外壳按 `appliesTo(selection)` 渲染在右侧控制面板。
- `run` 抛错由外壳展示；耗时操作自己维护进行中状态并禁用重复点击。
- 有破坏性的操作给 `confirm` 文案；不可执行时用 `disabledReason` 返回原因，而不是静默失败。
- 不要在面板里重复放同样的按钮，那会让同一次操作出现两个入口。

## 10. 性能与加载

- 面板内容按需 `lazy` 加载，重依赖（编辑器、图表、ProseMirror 这类）单独分块，别进首屏包。
- 单模块首屏同步代码控制在几百 KB 量级；超出的部分切块。
- 列表超过约 200 行时考虑虚拟化或分页。
- `Provider` 在模块启用时就会挂载，注意别在里面做重请求；列表加载放在 `Provider` 或侧边栏里按需触发。

## 11. 无障碍

- 折叠窄条整条可点击，带 `aria-label` 描述「什么 · 状态 · 展开某栏」。
- 操作按钮的禁用原因写进 `title`，不要只靠颜色。
- 折叠、展开、选择都要能用键盘完成。

## 12. 交付物

每个模块至少包含：

- `SPEC.md`：功能意图、关键功能与可验收的行为（结构见仓库其他模块）。
- 与外壳契约的接入代码（模块对象 + 侧边栏 + 工作区 + context），以及不依赖外壳也能跑的独立入口或独立部署说明。
- 单元测试覆盖选中映射、侧边栏折叠态文案、操作可用性判断；有 API 交互的补 e2e。
- 文档里写明：依赖哪些服务、需要哪些环境变量、数据归属在哪。

## 13. 反面清单（都踩过）

| 反例 | 后果 |
| --- | --- |
| 模块内部再套一层可拖拽 `Group` 当主布局 | 与外壳的分栏打架，出现栏里套栏 |
| `Provider` 里渲染 `<div className="x-app">` | 根类落到侧边栏面板，工作区样式全丢 |
| 工作区组件里再画一遍模块标题 | 与侧边栏标题重复，占掉内容高度 |
| 侧边栏折叠态只靠 CSS 隐藏内容 | 高度仍占着，堆叠失效 |
| 模块挂载时无条件 `select(null)` | 抹掉别的模块发布的选中 |
| `styles.css` 里写 `html/body/#root` | 污染宿主布局 |
| 面板内放「执行」按钮，同时注册 action | 同一操作两个入口 |
| 浮层用全局 `position: fixed` | 多区域布局下坐标错位 |
| 依赖 `keepMounted` 之外的方式保活 | 折叠即卸载，iframe 与终端状态丢失 |
| 发送方直接 import 接收方的 store 或 api | 模块边界失效，删模块编译不报错、运行期才炸 |
| 用字符串意图名替代命令注入 | 依赖关系在 import 图里不可见，等于手写第二套类型系统 |

## 14. 检查清单

- [ ] `id` 唯一、小写短横线；`title` 简短
- [ ] `Sidebar` 同时处理展开与折叠两种形态
- [ ] `Workspace` 不含模块标题区
- [ ] `context.kind` 全局唯一；只清除自己的选中
- [ ] `Provider` 不渲染 DOM；样式作用域在 `Sidebar` / `Workspace` 内部
- [ ] 没有嵌套可拖拽 Group，宽度自适应
- [ ] 轮询/通知/键盘监听可关闭或可移除
- [ ] 动作注册在 `actions`，有 `disabledReason` / `confirm`
- [ ] 需要保活的模块声明 `keepMounted`
- [ ] 跨模块能力以 `commands` 从工厂导出，接收方自行校验参数
- [ ] 跨模块操作的 `disabledReason` 用 `shell.enabled` 判断接收方启用状态
- [ ] 会改接收方持久状态的操作带 `confirm`，文案里带出实际参数
- [ ] 有 `SPEC.md`、单测、独立运行说明
