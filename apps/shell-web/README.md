# 工作区入口

把多个模块组合进一个固定工作区的独立入口。组合关系全部在 `package.json` 与 `src/registry.tsx` 里显式声明：模块以 npm workspace 包或仓库内源码接入，宿主依赖它们并调用各自导出的模块工厂。当前接入 todo、flow、fs、ssh、沙箱、pi 会话、pi 对话与 pi 配置八个模块。

## 页面结构

外壳固定为五块，宿主与模块都不改这个骨架：

- **标题栏** 40px：宿主标题、profile 切换器、Profiles 配置页入口与设置、注册表入口。
- **侧边栏**：启用模块自上而下堆叠成手风琴，同一时刻只有一节展开并占满侧栏高度，其余模块只留一条 32px 横向窄条。折叠方向是上下，按钮用 ↑ / ↓。
- **工作区**：只显示侧边栏处于展开态的那个模块，单列铺满；选中设置或注册表时整块让给宿主页面。
- **控制面板**：按全局选中聚合模块声明的操作。
- **状态栏** 24px：左侧是展开模块的上下文信息，右侧是宿主状态。

## 骨架预览

不连任何后端也能看结构：示例模块把五个区域填满，用来核对手风琴折叠、工作区单列、控制面板与状态栏的行为。

```sh
npm run dev:shell-web
# 打开 http://localhost:5191/skeleton.html
```

示例模块在 `src/skeleton/modules.tsx`：任务与文件演示列表选中、沙箱演示实例列表与详情、终端演示侧边栏与工作区共享 `Provider` 状态（点「新建会话」，右边数字同步变）。右上「宿主页面」演示 `views` 占用整个工作区。预览数据全在内存，不写后端。

预览页也演示了跨模块契约：文件模块由工厂导出具名命令，任务模块通过注入使用它。在「任务」里选中一项，控制面板出现「在文件模块打开项目目录」，执行后文件模块被登记并自动展开。切到「仅任务」profile 后同一操作显示禁用原因。

## 页面 profile

profile 只声明启用哪些模块与顺序，不再描述区域布局：

| profile | 模块 |
| --- | --- |
| 工作（`work`） | todo、fs-web、ssh |
| 终端（`terminal`） | ssh、fs-web |
| 沙箱（`sandbox`） | 沙箱、ssh |
| 会话（`history`） | pi-sessions、fs-web |
| Flow（`flow`） | flow、fs-web |
| Pi 控制台（`pi`） | pi-chat、pi-sessions、pi-config、fs-web |
| 对话（`chat`） | pi-chat |
| Pi 配置（`pi-config`） | pi-config、fs-web |

上表是 `registry.tsx` 里的默认值。标题栏的 **Profiles** 页可编辑：新建、改名、删除 profile，并用「＋ 未启用模块 / 移除 / ↑ ↓」决定每个 profile 启用哪些模块与堆叠顺序。改动即时生效并写入 `ursi.workspace:profiles`，标题栏切换器同步更新；「恢复默认」丢弃自定义配置回到上表。

默认只展开第一个模块；展开的是哪一节按 `ursi.workspace:<profile>:expanded` 持久化，当前 profile 存于 `ursi.workspace:profile`。切换 profile 会重挂布局表面，属可接受的低频行为。

编辑 profile 不会重挂布局表面：改完模块集合后侧边栏与工作区就地刷新，被移除的模块卸载，展开项已失效时回退到第一个启用模块。删掉当前 profile 时切换器回退到第一个，不留空白选择。至少保留一个 profile，最后一个的删除按钮禁用。

## 开发

```sh
npm install
npm run dev:shell-web        # http://localhost:5191
```

`vite.config.ts` 把 `/api` 代理到 todo-web 服务（默认 `http://127.0.0.1:8090`，可用 `TODO_WEB_API` 覆盖），把 `/api/fs-web` 代理到 fs-web（`FS_WEB_API`）、`/api/ssh-web` 代理到 ssh-web（`SSH_WEB_API`）、`/api/pi-sessions` 代理到会话目录服务并重写回 `/api`（`PI_SESSIONS_API`，默认 `http://127.0.0.1:30200`），把 `/api/flow-web` 代理到 flow-web 服务并重写回 `/api`（`FLOW_WEB_API`，默认 `http://127.0.0.1:8094`），把 `/sbx` 代理到沙箱控制台服务（`SBX_WEB_API`）。先启动对应后端：

```sh
cd apps/todo-web/server && cargo run        # 或已有实例
cd apps/fs-web/server && ...                # 8199
cd apps/ssh-web/server && ...               # 8091
cd apps/pi-sessions-web/server && npm start  # 30200
cd apps/flow-web/server && npm start        # 8094（先构建 apps/ursi-flow）
```

## 模块怎么加

组合根 `src/registry.tsx` 是全应用唯一允许出现宿主胶水代码的地方：登记模块清单、注入模块 options（如 `apiBaseUrl`）、声明不占侧边栏的宿主页面，开发期校验模块 id 与 `context.kind` 全局唯一，撞名直接报错而不是被静默掩盖。

模块契约见 [`packages/workspace-shell/MODULE-CONTRACT.md`](../../packages/workspace-shell/MODULE-CONTRACT.md)。要点：

- 模块声明 `Sidebar`（`{ collapsed, collapse, expand }`）、`Workspace`（不含标题区）与 `context`（选中 kind、摘要、状态栏组件）。
- 需要跨侧边栏与工作区共享 React 上下文（拖拽、路由、controller）时声明 `Provider`，外壳会用同一个 Provider 包住三块内容。
- 侧边栏的折叠形态由模块渲染；外壳只提供 `SidebarFrame` 作为可选外框。

接入分三步：模块自己导出接入代码（如 `todo-web/web/src/module.tsx`），宿主 `package.json` 声明依赖，再在 `src/registry.tsx` 调用工厂并写进 profile。

## 跨模块协作

模块之间不互相 import，也不共享 store 或 API 实例。跨模块流程走三步：

1. 接收方工厂导出具名命令，例如 `createFsModule()` 返回的 `commands.openRoot(root)`。
2. 发送方只声明它需要的函数形状，例如 `createTodoModule({ openRootInFiles })`，不认识文件模块的任何代码。
3. 组合根 `registry.tsx` 把两者接起来，并在注册表页列出这条依赖边。

当前有两条真实的边：任务模块的「在文件模块打开项目目录」与 Flow 模块的「在文件模块打开 Flow 目录」都调用文件模块的 `openRoot`，登记并激活该目录，然后 `shell.reveal('fs-web')` 展开文件模块。目标模块不在当前 profile 时，该操作显示禁用原因而不是消失。

会改变接收方持久状态的操作必须带 `confirm`，确认文案里带出实际路径，避免一次误点就把任意目录登记成可浏览的文件根。

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

## 骨架预览与真实入口的关系

两者共用同一个 `WorkspaceShell` 与同一份契约，差别只在模块来源：`skeleton.html` 用 `src/skeleton/modules.tsx` 的内存示例，`index.html` 用 `registry.tsx` 里声明的真实模块。改外壳时先看骨架预览确认交互，再看真实入口确认模块没有回归。
