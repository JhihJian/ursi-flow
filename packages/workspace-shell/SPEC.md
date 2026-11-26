---
parent: ../../SPEC.md
---

# 工作区外壳

## 功能意图

`@ursi/workspace-shell` 给宿主一套固定的工作区骨架，并约束子模块只声明三块内容：

- 顶部标题栏：宿主标题、profile 切换器、宿主设置入口。
- 左侧侧边栏：启用模块自上而下堆叠，同一时刻只有一节展开，其余压成一条 32px 横向窄条。
- 中间工作区：只显示侧边栏处于展开态的那个模块的 `Workspace`，占满整个工作区。
- 右侧控制面板：按全局选中聚合各模块声明的操作。
- 底部状态栏：左侧是展开模块的上下文信息，右侧是宿主状态。

外壳不认识任务、文件、终端等领域概念，也不发请求。模块的侧边栏、工作区、状态栏内容由模块实现，外壳只负责布局、折叠交互、选中分派与操作渲染。

## 关键功能与验收

### 模块声明

模块对象声明 `id`、`title`、`Sidebar`、`Workspace`、`context`，可选 `Provider`、`collapsedSidebarSize`、`defaultExpanded`、`keepMounted` 与 `actions`。完整规范见 [MODULE-CONTRACT.md](MODULE-CONTRACT.md)。

#### 验收

- `Sidebar` 收到 `{ collapsed, collapse, expand }`，自己渲染展开与折叠两种形态；外壳不接收模块自绘的窄条组件，也不按摘要排版折叠 UI。
- `Workspace` 不含模块标题区；模块标题由侧边栏承担。
- `context` 声明本模块发布的选中 `kind`、摘要 `summary`，以及可选的状态栏组件 `Status`。
- 模块声明 `Provider` 时，外壳用它包住该模块的侧边栏、工作区与状态栏三块内容，三者共享同一份 React 上下文（dnd、路由、controller）。
- `Provider` 是纯上下文组件，不渲染布局 DOM。

### 侧边栏堆叠

外壳把启用模块按 profile 顺序堆成一列，手风琴式展开：同一时刻只有一节展开并占满侧栏剩余高度，其余模块固定为模块声明的窄条高度（缺省 32px）。

#### 验收

- 点击某一节的展开入口后，该节展开、原来展开的那节压回窄条，工作区同步换成新模块。
- 点击展开态的折叠按钮后该节压回窄条，工作区换成占位说明；点击另一节的窄条才重新展开。
- 折叠是上下方向：展开态用 ↑ 折叠，折叠态窄条用 ↓ 展开，不出现左右方向箭头。
- 展开项按 `${storageKey}:<profile>:expanded` 存单个模块 id 持久化，刷新后恢复；全部折叠时不写该项。
- 任一节折叠时，模块的侧边栏组件常驻（只切换 `collapsed`），内部状态不丢。
- 折叠态窄条整条可点击展开，带 `aria-label` 描述标题与关键信息。

### 工作区

工作区只渲染「侧边栏处于展开态」的那个模块，单列铺满可用宽度。

#### 验收

- 一个模块的侧边栏折叠后，它的 `Workspace` 从工作区移除；同时展开另一个模块时工作区只显示新的那个。
- 声明 `keepMounted` 的模块折叠时，`Workspace` 改投隐藏槽位继续挂载，iframe、终端等不重置；未声明时折叠即卸载。
- 没有展开模块时显示占位说明，不是空白。
- 未在 profile 中启用的模块完全不挂载。
- 选中 `views` 里的宿主页面（设置、注册表）时，工作区整体让给该页面；模块工作区按 `keepMounted` 规则卸载或保持隐藏。

### 右侧控制面板

模块通过 `actions` 声明操作项，含 `appliesTo`、`run`、可选 `disabledReason` 与 `confirm`。三个回调都收到 `ShellHandle`。

#### 验收

- 控制面板只列已启用模块中 `appliesTo(selection, shell)` 为真的操作，未选中时为空态说明。
- 操作执行期间按钮显示进行中文案并禁用其他操作；失败时在面板内显示错误，不丢失当前选中；`onError` 缺省写 `console.error`，宿主传入时以宿主为准。
- 声明 `confirm` 的操作先请求确认，取消后不执行；`confirm` 为函数时用实际参数生成文案。
- `shell.enabled(moduleId)` 反映当前 profile 的启用集合，模块据此为跨模块操作给出禁用原因。
- `shell.reveal(moduleId)` 展开该模块侧边栏；目标模块不在当前 profile 时报错；宿主页面正占用工作区时先退回模块视图。

### 跨模块协作

模块之间不互相 import，也不共享 store 或 API 实例。接收方由工厂导出具名 `commands`，组合根把它注入给发送方。

#### 验收

- 接收方工厂返回的 `commands` 只接受与返回普通值，不暴露实体、store 或 API 对象。
- 发送方的工厂参数只声明它需要的函数形状，不 import 接收方代码；删除接收方后工程无法通过类型检查。
- 组合根是唯一同时引用两端的地方，接线的边在注册表页可见。

### 状态栏

状态栏左侧渲染展开模块的上下文：声明了 `context.Status` 的模块留出槽位并渲染组件；否则在全局选中属于该模块时显示 `context.summary`。右侧显示宿主 `status`。

#### 验收

- 模块的 `Status` 随模块状态变化更新，不需要重新展开侧边栏。
- 没有展开模块也没有选中时显示 `No selection`。
- 状态栏固定 24px，不随窗口或分栏变化。

### 页面 profile

宿主传入 `profiles`，每项只声明 `id`、`title`、启用的模块 id 列表与顺序。提供 ≥2 个 profile 时标题栏出现切换器。

外壳另导出 `useStoredProfiles` 与 `ProfilesEditor`：宿主给一份默认 profile，用户就能在界面上定义有哪些 profile、每个启用哪些模块。

#### 验收

- 切换 profile 后侧边栏集合与顺序立即切换；上一 profile 的展开项不影响下一个。
- 未传 `profiles` 时启用全部模块，按 `modules` 数组顺序堆叠，默认展开第一个模块。
- profile 引用未注册的模块 id 时忽略该条目，其余模块正常渲染。
- 默认展开项优先取模块的 `defaultExpanded`；没有任何模块声明时展开第一个。
- 切换 profile 会重挂布局表面：iframe 类模块会重载一次，属可接受的低频行为。

### 通过界面配置 profile

`createProfilesStore({ storageKey, defaults })` 建一份外部存储（默认值 + `${storageKey}:profiles`），`useProfiles(store)` 订阅快照，`ProfilesEditor` 以 `views` 里的一项渲染并直接写 store。宿主把 `useProfiles` 的结果当 `profiles` 传给 `WorkspaceShell`，切换器与编辑页因此读同一份数据。

#### 验收

- 编辑页可新建、改名、删除 profile，并用「未启用模块」按钮添加、× 移除、↑ / ↓ 调序；列表顺序就是侧边栏堆叠顺序。
- 每次改动立即写盘，重新加载后配置还在；页内不存第二份 React 状态，标题栏切换器与编辑页永远一致。
- 宿主页面与编辑组件的引用在模块级固定，改配置不让当前页面重挂，输入框不丢焦点。
- 至少保留一个 profile，最后一个的删除按钮禁用；删除当前 profile 后切换器回退到第一个，展开状态按新 profile 重取。
- 编辑当前 profile 不重挂布局表面：被移除的模块卸载，展开项已失效时回退到 `defaultExpanded` 或第一个启用模块。
- 存储里是坏数据（非数组、空数组、缺 id、重复 id）时整份退回默认值，不让工作台起不来。
- 修改 profile 名称不影响 `id`，因此已有 `${storageKey}:<profile>` 下的展开状态与分栏尺寸继续有效。
- `reset` 清掉存储项并恢复宿主给的默认值；编辑页只在用户确认后才调用它。

## 边界

模块接入的具体规范见 [MODULE-CONTRACT.md](MODULE-CONTRACT.md)。

- 不提供路由、鉴权、数据获取和领域状态。
- 不做运行时插件加载，模块在构建期登记。
- 折叠 UI 的视觉归模块；外壳只提供 `SidebarFrame` 作为可选的外框辅助组件。
- 不提供 profile 的权限校验或多用户同步：配置只存在当前浏览器的 localStorage 里。
