# SUMM-Todo 看板

独立读取 SUMM-Todo 本机 SQLite 库的看板。Server 提供同源 API 并托管 Web 构建产物，界面与 [SUMM-Todo-Web](https://github.com/JhihJian/SUMM-Todo-Web) 保持一致。

## 目录

- `server/`：Rust + axum + rusqlite，读写 `~/.todo/todo.db`，托管 `web/dist`。
- `web/`：React 19 + TypeScript + Zustand + `@dnd-kit/core` + `react-resizable-panels`。

## 本地开发

先启动 Server（默认监听 `0.0.0.0:8090`，读取 `~/.todo/todo.db`）：

```sh
cd server
cargo run
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
cd server && cargo build --release
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
- 任务行首的 `⠿` 是拖拽手柄。拖动后状态标签与左侧项目项出现虚线放置提示；拖到状态标签改状态，拖到项目项改归属。
- 两条分隔线可拖动调整三栏宽度，悬停时显示 `⋮` 和拖动光标；双击分隔线恢复默认宽度。布局保存在浏览器本地。
- 完成任务后播放提示音并发送桌面通知，右下角按钮可静音。

## 交互实现

- `@dnd-kit/core` 提供任务的 `useDraggable` 与状态标签、项目项的 `useDroppable`，以及 6px 启动阈值、拖拽预览和放置高亮。拖拽结果通过 `PUT /api/tasks/{id}` 写回。
- `react-resizable-panels` 提供三栏 `Group` / `Panel` / `Separator`，限制每栏最小和最大宽度，并用 `useDefaultLayout` 保存和恢复布局。

## 检查

```sh
cd server && cargo test && cargo clippy
cd web && npm test && npm run build
```
