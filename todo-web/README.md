# SUMM-Todo 看板

独立读取 SUMM-Todo 本机 SQLite 库的看板。Server 提供同源 API 并托管 Web 构建产物，界面与 [SUMM-Todo-Web](https://github.com/JhihJian/SUMM-Todo-Web) 保持一致。

## 目录

- `core/`：`todo-core` crate，任务与项目的实体、状态机与错误码，最早来自 SUMM-Todo，现在由本目录维护。
- `server/`：Rust + axum + rusqlite，读写 `~/.todo/todo.db`，托管 `web/dist`，通过 `path = "../core"` 依赖上面的 crate。
- `Cargo.toml`：workspace，成员为 `core` 与 `server`，构建产物在 `target/`。
- `web/`：React 19 + TypeScript + Zustand + `@dnd-kit/core` + `react-resizable-panels`，Markdown 正文用 ProseMirror 做成所见即所得编辑器。

## 本地开发

待办库由 SUMM-Todo CLI 创建（`~/.todo/todo.db`），看板只读写现有库，不建表、不迁移。整个 Rust 侧只有 workspace 内的两个 crate，不依赖外部 git 仓库。

先启动 Server（默认监听 `0.0.0.0:8090`，读取 `~/.todo/todo.db`）：

```sh
cargo run -p todo-web-server
```

另开终端启动 Web（`/api` 代理到 `http://127.0.0.1:8090`；需要其他后端时设 `TODO_WEB_API`）：

```sh
cd web
npm ci
npm run dev
```

打开 http://localhost:5182 。

## 构建与运行

```sh
cd web && npm ci && npm run build
cd .. && cargo build --release
./target/release/todo-web-server
```

生产部署时用 `TODO_WEB_STATIC_DIR` 指向构建产物，或用同域反向代理把 `/` 指向 `web/dist`、`/api` 指向本服务。

## 配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TODO_DB_PATH` | `~/.todo/todo.db` | SUMM-Todo 本机库 |
| `PORT` | `8090` | HTTP 监听端口，绑定 `0.0.0.0` |
| `TODO_WEB_STATIC_DIR` | `web/dist` | 静态文件目录 |

## 使用

- 侧栏与内容栏都不放按钮，操作全走右键菜单，且按区域划分：
  - 项目侧栏：`New project`、`Edit project`、`Delete project`，列表空白处右键只给 `New project`。
  - 任务列表：任务行右键为 `New task`、`Delete task`，列表空白处右键只给 `New task`。
  - 删除都要二次确认，菜单标题行显示 `Delete "名称"?`，再点一次才执行。
- 点击任务行或任务列表右键菜单里的 `New task`，详情面板会从任务列表下方升起；底部 `Close` 或 `Esc` 收起。
- 详情标题行右侧的 `⧉` 可把面板内容复制成一份 Markdown 文档（标题作一级标题，状态、优先级、标签、时间作列表，正文原样接在后面），复制后图标短暂变成 `✓`。
- 详情是一份连续文档：大标题、一行元信息（带 `status`、`pri`、`tags`、`workspace`、`session` 小标签的状态、优先级、标签、关联工作区、关联会话与时间）、Markdown 正文，不切成表单块。优先级在这一行改。底部只有 `Close` 和 `Save`，删除任务走任务行的右键菜单。拖动顶部横条可调整面板高度，双击横条复位，高度会被记住。
- 正文是所见即所得的 Markdown 编辑区：输入 `**加粗**` 立刻变成加粗文本，输入 `# ` 变成标题，`- ` 变成列表，`> ` 变成引用，不再需要预览或源码切换。选中文字后 `Ctrl/Cmd+B`、`Ctrl/Cmd+I`、`Ctrl/Cmd+\`` 可切换加粗、斜体、行内代码。
- 编辑区覆盖 CommonMark 子集：标题、段落、列表、引用、代码块、行内代码、链接、粗斜体、分隔线、图片。GFM 表格等扩展语法不在此编辑器内，输入后按普通文本保存。
- 任务列表右上角的 `«` 把内容栏折叠成 32px 窄条，整个看板随之收窄到侧栏与窄条的实际宽度并靠左排列；窄条竖排显示当前选中任务的标题与 `状态 · 项目`，点它或 `»` 回到任务列表，折叠状态会被记住。
- 任务列表上方左侧的条形区显示最近 7 天每天新建的任务数，条宽随数量变化，悬停可看日期与数量；点某天只看当天创建的任务，再点一次取消。日期标签以 `MM-DD` 显示在条形左侧；右侧仍放状态标签。
- 按天或按状态筛选只影响任务表，不会关闭已经打开的详情面板。
- 任务列表上方的状态标签可点击筛选：点一次只看该状态，再点一次或点其它状态切换，全部取消后显示当前项目的所有任务。列表为空时提示 `No <status> tasks`。
- 任务行首的 `⠿` 是拖拽手柄。拖动后状态标签与左侧项目项出现虚线放置提示；拖到状态标签改状态，拖到项目项改归属。拖到 `blocked` 会先询问阻塞原因。状态迁移遵循 SUMM-Todo 状态机：完成任务前要先在详情里填写结果。
- 项目栏与内容栏之间的分隔线可拖动调整两栏宽度，悬停时显示 `⋮` 和拖动光标；双击分隔线恢复默认宽度。布局保存在浏览器本地。
- Projects 侧边栏点 `«` 可折叠成 32px 单列窄条：文字整体侧转 90° 并从下往上读，拉丁字母随行旋转、中文保持直立，依次显示当前项目名称、活跃任务数和累计时间，名称过长时截断，悬停看完整信息。点 `»` 或窄条展开，宽度回到折叠前的值。把分隔线拖到最小宽度也会自动折叠。
- 完成任务后播放提示音并发送桌面通知，右下角按钮可静音。

## 交互实现

- `@dnd-kit/core` 提供任务的 `useDraggable` 与状态标签、项目项的 `useDroppable`，以及 6px 启动阈值、拖拽预览和放置高亮。拖拽结果通过 `PUT /api/tasks/{id}` 写回。
- `react-resizable-panels` 提供两栏 `Group` / `Panel` / `Separator`，限制每栏最小和最大宽度，`collapsible` 的 Projects 面板支持折叠窄条，并用 `useDefaultLayout` 保存和恢复布局。

## 检查

```sh
cargo test && cargo clippy
cd web && npm test && npm run build
```
