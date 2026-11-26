# ssh-web

浏览器 SSH 终端：合并侧栏管理 SSH 连接与远端 tmux 会话，点会话即接入远端 PTY 终端；会话持久化由远端 tmux 承担。既可独立运行（vite 5193），也作为 ursi-flow 工作区的一栏模块（`@ursi/ssh-web/module`）接入，两端共用同一套组件。

## 组成

- `server/`：Rust 服务（axum + portable-pty + rusqlite）。托管静态页面、连接配置 CRUD、tmux 会话列表、设备资源采样与 WebSocket 终端桥；WS 握手即在本地 PTY 中启动系统 `ssh -tt` 子进程并 attach 远端 tmux，服务端不维护会话状态，认证、跳板、`~/.ssh/config` 全部交给 OpenSSH 自身。资源采样每次请求跑一轮独立批量 ssh，读远端 `/proc`、`ps` 并用通道一问一答量延迟。接口契约见 [server/HTTP.md](server/HTTP.md)。
- `web/`：React + TypeScript + Vite 前端。xterm.js 终端面板，出版物风格界面（与 todo-web 一致）。状态栏在终端已连接时缩略显示 CPU / 内存 / 延迟，终端区右侧的资源面板（`components/ResourcePanel.tsx`）按连接展示内存构成条、CPU 使用率与 1/5/15 分钟负载、内存、磁盘、延迟与网卡速率、内存前 5 进程，各项带走势线。终端渲染层在 `web/src/terminal/`：主题与最小对比度、实测 cell 尺寸的 fit 调度、WebGL 策略、Unicode 宽度与链接解析。
- `web/src/ssh-context.tsx`：模块的 controller（API 通道 + zustand store）工厂。API 前缀与 localStorage 键都由创建参数注入，不设模块级单例；独立入口传 `/api`，工作区嵌入由宿主传 `/api/ssh-web`（vite 代理重写回 8091 的 `/api`，HTTP 与 WS 同规则）。

## 渲染层来源

终端渲染细节移植自 [orca](https://github.com/stablyai/orca) 的 `src/renderer`（MIT，Copyright (c) 2026 Lovecast Inc.），针对浏览器环境做了裁剪：

- `terminal/fit.ts`：`StableCellFitAddon` 与 `terminalGridSizeForBox` 来自 `pane-manager/terminal-fit`，另加两帧稳定的 fit 调度。
- `terminal/renderer.ts`：WebGL 可用性判定、上下文丢失降级与 DPR 修复来自 `pane-manager/terminal-rendering`。
- `terminal/unicode.ts`：Unicode 11 + ZWJ 宽度 provider，来自 `shared/terminal/appearance/terminal-unicode-provider.ts`。
- `terminal/theme.ts`、`terminal/color.ts`：最小对比度取值与滚动条按前景对比度染色的算法来自 orca 的 `terminal-themes` 与 `appearance/terminal-appearance.ts`；ANSI 调色板改为本模块自有的灰阶 + 低饱和专色方案，与页面排版同源。
- `terminal/search.tsx`：搜索面板交互与装饰高亮，来自 `components/terminal-pane/search`。
- `terminal/links.ts`、`terminal/http-url.ts`、`terminal/prose-url.ts`：跨行 URL 识别与悬停提示，来自 `components/terminal-pane/links` 与 `shared/terminal/links`（去掉了 orca 的硬换行启发式）。

## 运行

```sh
# 服务端（默认 0.0.0.0:8091，数据库 ~/.ursi/ssh/ssh.db）
cargo run -p ssh-web-server

# 前端开发（vite 5193，/api 代理到 8091，WS 同样代理）
cd web && npm run dev

# 生产：构建前端后由服务端托管
cd web && npm run build
```

工作区嵌入无需单独启动前端：宿主 shell-web 的 vite 把 `/api/ssh-web/*`（含 WS）代理到 8091 并重写为 `/api/*`，目标可用 `SSH_WEB_API` 环境变量覆盖。

环境变量：`PORT`（服务端口）、`URSI_DATA_DIR`（数据根目录，默认 `~/.ursi`）、`SSH_DB_PATH`（直接指定 SQLite 路径）、`SSH_WEB_STATIC_DIR`（静态目录覆盖，默认 `web/dist`）。

功能边界与验收见 [SPEC.md](SPEC.md)。
