# SUMM-Todo 看板

独立读取 SUMM-Todo 本机 SQLite 库的看板。Server 提供同源 API 并托管 Web 构建产物，界面与 [SUMM-Todo-Web](https://github.com/JhihJian/SUMM-Todo-Web) 保持一致。

## 目录

- `core/`：`todo-core` crate，任务与项目的实体、状态机与错误码，最早来自 SUMM-Todo，现在由本目录维护。
- `server/`：Rust + axum + rusqlite，读写 `~/.ursi/todo/todo.db`，托管 `web/dist`，通过 `path = "../core"` 依赖上面的 crate。
- `Cargo.toml`：workspace，成员为 `core` 与 `server`，构建产物在 `target/`。
- `web/`：React 19 + TypeScript + Zustand + `@dnd-kit/core` + `react-resizable-panels`，Markdown 记录与结果用 ProseMirror 做成所见即所得编辑器。

## 本地开发

数据根目录默认是 `~/.ursi`，可用 `URSI_DATA_DIR` 指向其它位置，待办库文件为 `<数据根目录>/todo/todo.db`，也可用 `TODO_DB_PATH` 直接指定；看板只读写现有库，不建表、不迁移。整个 Rust 侧只有 workspace 内的两个 crate，不依赖外部 git 仓库。

先启动 Server（默认监听 `0.0.0.0:8090`，读取 `~/.ursi/todo/todo.db`）：

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
| `URSI_DATA_DIR` | `~/.ursi` | 数据根目录 |
| `TODO_DB_PATH` | `$URSI_DATA_DIR/todo/todo.db` | 待办库文件 |
| `PORT` | `8090` | HTTP 监听端口，绑定 `0.0.0.0` |
| `TODO_WEB_STATIC_DIR` | `web/dist` | 静态文件目录 |

## 使用

- 侧栏与内容栏都不放按钮，操作全走右键菜单，且按区域划分：
  - 项目侧栏：`New project`、`Edit project`、`Delete project`，列表空白处右键只给 `New project`。
  - 任务列表：任务行右键为 `New task`、`Delete task`，列表空白处右键只给 `New task`。
  - 删除都要二次确认，菜单标题行显示 `Delete "名称"?`，再点一次才执行。
- 点击任务行或任务列表右键菜单里的 `New task`，详情面板会从任务列表下方升起；底部 `Close` 或 `Esc` 收起。
- 详情标题行右侧的 `⧉` 可把面板内容复制成一份 Markdown 文档（标题作一级标题，状态、优先级、标签、时间作列表，正文原样接在后面），复制后图标短暂变成 `✓`。
- 详情是一份连续文档：大标题、一行元信息（带 `status`、`pri`、`tags` 小标签的状态、优先级、标签与时间）、`Record` 与 `Result` 两个 Markdown 编辑区，不切成表单块。优先级在这一行改。底部只有 `Close` 和 `Save`，删除任务走任务行的右键菜单。拖动顶部横条可调整面板高度，双击横条复位，高度会被记住。
- `Record` 记录工作过程，`Result` 记录工作结果，两者都是可选字段，分别存到任务的 `log` 与 `result`。完成任务必须填 `Result`，完成或撤销完成都不会清空 `Record`。
- 两个编辑区都是所见即所得的 Markdown：输入 `**加粗**` 立刻变成加粗文本，输入 `# ` 变成标题，`- ` 变成列表，`> ` 变成引用，不再需要预览或源码切换。选中文字后 `Ctrl/Cmd+B`、`Ctrl/Cmd+I`、`Ctrl/Cmd+\`` 可切换加粗、斜体、行内代码。
- 服务端提供 `POST /api/tasks/{id}/result/append`（请求体 `{ "text": "..." }`）给 Agent 追加工作结果：新内容去掉首尾空白后与已有结果用空行分隔拼接，返回 `{ "result": "..." }`。字段与接口见 [server/HTTP.md](server/HTTP.md)。
- 编辑区覆盖 CommonMark 子集：标题、段落、列表、引用、代码块、行内代码、链接、粗斜体、分隔线、图片。GFM 表格等扩展语法不在此编辑器内，输入后按普通文本保存。
- 任务列表上方左侧的条形区显示最近 7 天每天新建的任务数，结构与 pi-sessions 的按日筛选一致：一行「按日筛选」、日期范围与 `全部`、`今天` 快捷项，下面是分布条；各天按数量占比分宽，悬停可看日期与数量；内容区较窄时先隐藏时间列，再隐藏条形区。
- 条形可多选：点某天只看当天创建的任务，再点取消；`全部` 清空筛选，`今天` 只选今天；多选时合并显示所选日期创建的任务。
- 按天或按状态筛选只影响任务表，不会关闭已经打开的详情面板。
- 任务区右上角的 `列表` / `图` 切换任务表与关系图。关系图把 `parent_id` 显示成包含子任务的分组节点（标题条上有子任务数），`pre_id` 显示成虚线前置边，按项目全量任务绘制；默认只显示待办、进行中与阻塞任务，完成与已取消任务只在与未完成任务直接关联时出现。点节点打开该任务详情，视图选择刷新后保留。
- 图里可以直接改关系：按住 `Shift` 把节点拖到另一个节点上松手，前者成为后者的子任务；从节点左侧圆点拖到另一个节点，前者成为后者的前置任务。连线上右键可删除前置依赖，节点上右键可解除父子关系。成环或指向自身的拖拽会被拒绝并提示。
- 顶层节点可以直接拖动调整位置，坐标按项目保存在浏览器本地，刷新后保留，分组里的子任务跟着走。没有手动位置的节点继续自动排版并让开它们。右上角 `Reset layout` 清空当前项目的手动位置，节点右键 `Reset position` 只还原该节点。
- 任务列表上方的状态标签只显示符号与计数，悬停可看状态名，点击可筛选：点一次只看该状态，再点一次或点其它状态切换，全部取消后显示当前项目的所有任务。列表为空时提示 `No <status> tasks`。
- 任务行首的 `⠿` 是拖拽手柄。拖动后状态标签与左侧项目项出现虚线放置提示；拖到状态标签改状态，拖到项目项改归属。拖到 `blocked` 会先询问阻塞原因。状态迁移遵循 SUMM-Todo 状态机：完成任务前要先在详情里填写结果。
- 项目栏与内容栏之间的分隔线可拖动调整两栏宽度，悬停时显示 `⋮` 和拖动光标；双击分隔线恢复默认宽度。布局保存在浏览器本地。
- Projects 侧边栏点 `«` 可折叠成 32px 单列窄条：文字整体侧转 90° 并从下往上读，拉丁字母随行旋转、中文保持直立，依次显示当前项目名称、活跃任务数和累计时间，名称过长时截断，悬停看完整信息。点 `»` 或窄条展开，宽度回到折叠前的值。把分隔线拖到最小宽度也会自动折叠。嵌入工作区外壳时改用外壳的上下折叠窄条。
- 完成任务后播放提示音并发送桌面通知。独立页面右下角有静音按钮；嵌进工作区外壳时这个按钮不出现，避免浮在宿主的控制面板上。

## 交互实现

- `@dnd-kit/core` 提供任务的 `useDraggable` 与状态标签、项目项的 `useDroppable`，以及 6px 启动阈值、拖拽预览和放置高亮。拖拽结果通过 `PUT /api/tasks/{id}` 写回。
- `react-resizable-panels` 提供两栏 `Group` / `Panel` / `Separator`，限制每栏最小和最大宽度，`collapsible` 的 Projects 面板支持折叠窄条，并用 `useDefaultLayout` 保存和恢复布局。

## 检查

```sh
cargo test && cargo clippy
cd web && npm test && npm run build
```
