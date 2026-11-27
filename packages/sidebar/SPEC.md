---
parent: ../../SPEC.md
---

# 侧栏共用组件

## 功能意图

`@ursi/sidebar` 收编各应用侧边栏里重复实现的两样东西：列表行的「左侧 2px 竖线 + hover 灰底」视觉，以及右键菜单 `ContextMenu`。收编前 `ContextMenu` 在 todo-web、ssh-web、fs-web、pi-web（会话与配置两处）各有一份几乎相同的拷贝，其中四份用 `position: fixed` 挂到 `document.body`，违反 [workspace-shell 契约](../workspace-shell/MODULE-CONTRACT.md) 第 6 节。今后改侧边栏行的视觉或右键菜单，只改这一个包。

包只导出两样：`ContextMenu` 组件与 `style.css`（`.sb-row*` 与 `.sb-menu*`）。它与 `@ursi/directory-picker` 同类：共享 UI 包，不是业务模块，不持有数据，不含请求。

设计上刻意不做的：

- 不做「树」组件。八个列表里只有 ssh-web 的 `ConnectionTree` 是真正的两级树，其余都是平铺列表，「树」是伪命题。
- 不做带 slots 的 `TreeRow` 组件。各应用行内交互差异过大（todo 拖放两态、ssh 父行点击展开并内嵌折叠按钮、fs 目录行第二行点击复制路径），抽成组件会导致 props 爆炸。行只共享样式类，结构留给调用方。
- 不定义自己的变量体系。颜色直接消费外壳的 `--ws-*` 变量，一层回退。

## 关键功能与验收

### 列表行样式（`.sb-row`）

行元素加 `sb-row`，选中态加 `is-active`。只管三个视觉原子：左侧 2px 竖线（激活时为 `--ws-ink`）、hover 灰底（`--ws-line`）、文字截断（`.sb-row-label`）。行高、字号、内边距、布局留给调用方。

竖线用 `inset box-shadow` 画，不用 `border-left`：调用方常是 `button` 或有自己的边框与内边距重置，`box-shadow` 不会被它们覆盖，也不占盒模型宽度。代价是行内容比原来左移 2px，调用方把左内边距加 2px 即可保持视觉不变。

#### 验收

- `style.css` 在各入口于模块样式**之前**加载（shell-web 的 `registry.tsx` 与各独立入口的 `main.tsx` 均已如此）。模块自己刻意的底色（如 todo 拖拽悬停的白底）因此能盖过 `.sb-row:hover` 的灰底。
- 接入行：todo `ProjectItem`、ssh 父行与子行、pi 会话 `session-item`、flow `flow-item`。fs 目录列表（圆角两行）、fs 文件树（虚拟化双击重命名）、pi Home 行（三行）暂不接。
- hover 灰底统一为 `--ws-line`（#e5e5e5）。接入前 pi 会话用 #f5f5f5、flow 用 #fafafa，现在与 todo、ssh 一致。
- 无全局选择器，无 `position: fixed`。

### 右键菜单（`ContextMenu`）

`<ContextMenu state onClose container />`。`state` 为 `null` 时不渲染。`container` 必填，菜单 portal 进它并用 `position: absolute` 定位，容器自己要有 `position: relative` 且不滚动。

`MenuState` 是 `{ x, y, heading?, items }`，`x/y` 是**容器相对坐标**：调用方用 `event.clientX/Y` 减去 `container.getBoundingClientRect()` 的 `left/top` 得到。`heading` 是顶部说明行，用于删除确认。`MenuItem` 是 `{ label, onSelect, danger?, disabled?, reason?, icon?, checked? }`，取五份拷贝的并集。

定位：宽固定 200，行高固定 30。右侧放不下就左翻到指针左边，翻过去也放不下（窄栏）就贴左。上下夹在容器内。关闭时机：点菜单外（捕获阶段，且阻止这次 `pointerdown` 继续触发宿主行为）、Esc、窗口 resize、页面滚动（菜单自身内滚除外）。点菜单项先关再执行 `onSelect`。容器未挂载时（ref 回调首次给 `null`）不渲染也不挂监听，Esc 不会误触发 `onClose`。

二次确认模式：调用方在第一层菜单项的 `onSelect` 里用 `document.querySelector('[data-xxx-id]').getBoundingClientRect()` 取目标 rect，换算成容器相对坐标后再开一层带 `heading` 的确认菜单。

#### 验收

- 替换了全部五份侧边栏拷贝：todo `ProjectList`、ssh `ConnectionTree` 与 `TerminalPane`、fs `tree` 与 `workspace-list`、pi 会话与配置。
- todo、fs、pi 配置三家原来是视口坐标，已改为容器相对坐标；ssh 与 pi 会话原本就是。
- todo 的工作区菜单（`TaskSection`、`TaskGraph`）仍用本地拷贝，没有收编：任务图是整页滚动画布，菜单要越过多个滚动容器，需要先给工作区找一个不滚动的定位容器，是另一件事。
- 组件测试 16 例覆盖：坐标夹紧与左翻、点外关闭与阻止冒泡、Esc、resize、滚动、点菜单内不关、禁用项不触发、先关再选、容器为 null 不渲染（`npm run test:sidebar`）。

### 菜单容器的选择

菜单容器要满足两点：不滚动，且 `position: relative`。各模块的接法：

- todo：`ProjectList` 外面多包一层 `.project-list-frame`（不滚动）作容器，内层 `.project-list-body` 照旧滚动。
- ssh：既有侧边栏根。
- pi：`.pi-sidebar` 根经 `menuContainer` prop 下发到会话与配置两处。
- fs：`.wsx-explorer` 根，经 `MenuContainerProvider` 下发到两列列表（`menu-container.ts` 单独成文件，避免 explorer 与 tree 互相 import）。

#### 验收

- 各模块 typecheck 通过，既有测试通过（pi 51 例、todo 74 例、flow 28 例）。

## 归属与边界

- 父级：[ursi-flow](../../SPEC.md)。零运行时依赖（React 为 peer），不依赖其它 `packages/`。
- 各模块 package.json 以 `"@ursi/sidebar": "*"` 依赖，样式由入口或组合根引入，模块之间不互相 import。
- 后续新应用接侧边栏行时：行加 `sb-row`、选中加 `is-active`、左内边距加 2px；右键菜单传一个不滚动且 `position: relative` 的容器。
- 工作区（非侧边栏）的菜单不属于本包范围。
