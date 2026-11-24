# 子模块接入规范

给 `apps/workspace` 写新模块（workspace-web、executor-web 等）时按这份规范做。外壳只负责一栏的宽度、折叠、全局选中与右侧操作栏，其余都归模块。

## 1. 导出一个模块对象

```ts
import type { WorkspaceModule } from '@ursi/workspace-shell'

export function createExecutorModule(): WorkspaceModule {
  return {
    id: 'executor',                       // 小写短横线，全局唯一，用于布局持久化
    title: 'Executor',                    // 折叠摘要与无障碍标签用
    Panel: ExecutorPanel,                 // 展开态内容，自己取数据
    defaultSize: 420,
    minSize: 280,                         // 低于此宽度外壳会折叠，别写大于实际需要的值
    hideHeader: false,                    // 模块自带标题/工具条时设 true
    useCollapsedSummary: useExecutorSummary,
    selection: { kind: 'run.attempt', summary, WorkspaceView },
    actions: [...],
  }
}
```

必填只有 `id`、`title`、`Panel`。其余按需。

## 2. 选中：只发布 ID，不另存真值

- 用 `useWorkspace().select({ kind, id, label })` 发布，`kind` 形如 `<域>.<实体>`，避免与别的模块撞名。
- 只传 `kind` 与 `id`；实体由模块按 id 自取，不要把对象塞进选中里。
- 模块内部不要再维护一份「当前选中」并双写；外壳的 `selection` 就是唯一真值。
- 卸载或清空时 `select(null)`。

## 3. 折叠：只公布数据，不写折叠 UI

- 折叠由外壳负责。模块实现 `useCollapsedSummary()`，返回 `{ title, items: [{ label, value }] }`。
- `items` 控制在 2–4 项，值是短字符串（状态、项目、数量），不要放大段文本或长 ID。
- 不要导出 `Rail` 之类的自绘折叠组件，也不要在模块内另做一套收放逻辑。
- 需要「展开后更宽」时用 `useModuleColumn().resize(px)` 主动请求，不要自己套一层可拖拽布局。

## 4. 布局：一栏之内自适应

- **不要嵌套 `react-resizable-panels` 的 `Group`**：外壳已经管一栏，里面再套一层会出现栏里套栏、宽度打架。
- 不要写死超过栏宽的像素默认值；用 `flex` 与 `min-width: 0`，表格允许横向滚动或收列。
- 需要固定宽度只用在小块（图标栏、列表），并给栏留出 `minSize` 的余量。
- 滚动放在栏内自己的容器上，不要让整页滚动；外壳已固定标题栏与状态栏。

## 5. 样式：进容器作用域

- 所有样式挂模块根类（如 `.executor-app`），必要时用 `@layer`，变量挂在该容器上。
- 禁止写 `html`、`body`、`:root`、`#root`、全局 `*` 重置、`overflow` 之类的全局规则；嵌入后会污染宿主。
- 避免 `position: fixed`；需要浮层时用 `position: absolute` 挂在容器内。
- 视觉沿用外壳的灰度、衬线标题 + 等宽数据；不要引入彩色主题。

## 6. 副作用：可关闭、可注入

- 接口地址由宿主注入（`apiBaseUrl`），不要硬编码 `/api`。
- 轮询、通知、声音、桌面通知这类全局行为要有开关，默认在嵌入模式下关闭。
- `window` 上的键盘监听要么挂容器，要么在失焦/卸载时移除；不要抢占宿主的 `Esc`。
- 不要用 `alert` / `prompt` / `confirm`；错误交给 `onNotify`（或操作栏的错误位）展示。
- `localStorage` 键加模块前缀（`executor.xxx`），并允许宿主注入 `storageKey`，避免两个实例互相覆盖。

## 7. 操作：注册，不自造按钮

- 「执行」「取消」「打开会话」这类动作注册成 `actions[]`，外壳按 `appliesTo(selection)` 渲染在右侧操作栏。
- `run` 抛错由外壳展示；耗时操作自己维护进行中状态并禁用重复点击。
- 有破坏性的操作给 `confirm` 文案；不可执行时用 `disabledReason` 返回原因，而不是静默失败。
- 不要在面板里重复放同样的按钮，那会让同一次操作出现两个入口。

## 8. 性能与加载

- 面板内容按需 `lazy` 加载，重依赖（编辑器、图表、ProseMirror 这类）单独分块，别进首屏包。
- 单模块首屏同步代码控制在几百 KB 量级；超出的部分切块。
- 列表超过约 200 行时考虑虚拟化或分页。

## 9. 无障碍

- 折叠摘要整条可点击，带 `aria-label` 描述「什么 · 状态 · 展开某栏」。
- 操作按钮的禁用原因写进 `title`，不要只靠颜色。
- 键盘操作与鼠标等价：折叠、展开、选择都要能用键盘完成。

## 10. 交付物

每个模块至少包含：

- `SPEC.md`：功能意图、关键功能与可验收的行为（结构见仓库其他模块）。
- 与外壳契约的接入代码（模块对象 + 折叠摘要 + 操作），以及不依赖外壳也能跑的独立入口或独立部署说明。
- 单元测试覆盖选中映射、折叠摘要、操作可用性判断；有 API 交互的补 e2e。
- 文档里写明：依赖哪些服务、需要哪些环境变量、数据归属在哪。

## 11. 反面清单（都踩过）

| 反例 | 后果 |
| --- | --- |
| 模块内部再套一层可拖拽 `Group` | 栏里套栏，520px 的栏里子栏被压到 25px |
| 写死 `defaultSize=240/300` 的像素宽度 | 嵌入窄栏时内容被挤没 |
| 用底部 sheet 放详情，同时外壳也有工作区 | 两处详情、两份选中真值 |
| `styles.css` 里写 `html/body/#root` | 污染宿主布局 |
| 面板内放「执行」按钮，同时注册 action | 同一操作两个入口 |
| 折叠自己实现一套窄条 UI | 与外壳形态重复，还多一套需要维护的状态 |
| 折叠按钮放在分隔线中点且不设光标 | 悬停被库强制成拖拽光标，误触拖拽 |

## 12. 检查清单

- [ ] `id` 唯一、小写短横线；`title` 简短
- [ ] `Panel` 自己取数据，不依赖宿主注入的 store
- [ ] 选中只发 `{ kind, id }`，模块内没有第二份选中
- [ ] `useCollapsedSummary` 返回 ≤4 项短值
- [ ] 没有嵌套可拖拽 Group，宽度自适应
- [ ] 样式全部在容器作用域内
- [ ] 轮询/通知/键盘监听可关闭或可移除
- [ ] 动作注册在 `actions`，有 `disabledReason` / `confirm`
- [ ] 重依赖按需加载
- [ ] 有 `SPEC.md`、单测、独立运行说明
