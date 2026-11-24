# SUMM-Todo 看板

独立读取 SUMM-Todo 本机 SQLite 库的看板。Server 提供同源 API 并托管 Web 构建产物，界面与 [SUMM-Todo-Web](https://github.com/JhihJian/SUMM-Todo-Web) 保持一致。

## 目录

- `core/`：`todo-core` crate，任务与项目的实体、状态机与错误码，最早来自 SUMM-Todo，现在由本目录维护。
- `server/`：Rust + axum + rusqlite，读写 `~/.todo/todo.db`，托管 `web/dist`，通过 `path = "../core"` 依赖上面的 crate。
- `Cargo.toml`：workspace，成员为 `core` 与 `server`，构建产物在 `target/`。
- `web/`：React 19 + TypeScript + Zustand + `@dnd-kit/core` + `react-resizable-panels`，Markdown 预览用 `react-markdown` + `remark-gfm`。

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

- 顶部统计块显示项目数、今日、本周、本月与全部任务数，点击切换任务表的周期筛选。
- 点击任务行、活动任务或 `+ Task`，详情面板会从任务列表下方升起；`×` 或 `Esc` 收起。
- 详情是一份连续文档：大标题、一行元信息（状态、优先级、标签、时间）、Markdown 正文，不切成表单块。拖动顶部横条可调整面板高度，双击横条复位，右上角 `⤢` 一键展开／还原。
- 正文用 Markdown 书写，切到 `Preview` 查看渲染结果，支持 GFM 表格、任务列表、删除线和自动链接；未开启原始 HTML 渲染，HTML 只作为文本显示。
- 任务行首的 `⠿` 是拖拽手柄。拖动后状态标签与左侧项目项出现虚线放置提示；拖到状态标签改状态，拖到项目项改归属。状态迁移遵循 SUMM-Todo 状态机：完成任务前要先在详情里填写结果，阻塞要填写原因。
- 两条分隔线可拖动调整三栏宽度，悬停时显示 `⋮` 和拖动光标；双击分隔线恢复默认宽度。布局保存在浏览器本地。
- Projects 侧边栏点 `«` 可折叠成 32px 单列窄条：文字整体侧转 90° 并从下往上读，拉丁字母随行旋转、中文保持直立，依次显示当前项目名称、活跃任务数和累计时间，名称过长时截断，悬停看完整信息。点 `»` 或窄条展开，宽度回到折叠前的值。把分隔线拖到最小宽度也会自动折叠。
- 完成任务后播放提示音并发送桌面通知，右下角按钮可静音。

## 交互实现

- `@dnd-kit/core` 提供任务的 `useDraggable` 与状态标签、项目项的 `useDroppable`，以及 6px 启动阈值、拖拽预览和放置高亮。拖拽结果通过 `PUT /api/tasks/{id}` 写回。
- `react-resizable-panels` 提供三栏 `Group` / `Panel` / `Separator`，限制每栏最小和最大宽度，`collapsible` 的 Projects 面板支持折叠窄条，并用 `useDefaultLayout` 保存和恢复布局。

## 检查

```sh
cargo test && cargo clippy
cd web && npm test && npm run build
```
