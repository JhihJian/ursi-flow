# ssh-web

浏览器 SSH 终端：管理 SSH 连接配置，点击连接即在浏览器中获得远端 PTY 终端。

## 组成

- `server/`：Rust 服务（axum + russh + rusqlite）。托管静态页面、连接配置 CRUD 与 WebSocket 终端桥。远端有 tmux 时自动接入固定会话 `ssh-main`，断开保活、重连恢复。接口契约见 [server/HTTP.md](server/HTTP.md)。
- `web/`：React + TypeScript + Vite 前端。xterm.js 终端面板，出版物风格界面（与 todo-web 一致）。

## 运行

```sh
# 服务端（默认 0.0.0.0:8091，数据库 ~/.ursi/ssh/ssh.db）
cargo run -p ssh-web-server

# 前端开发（vite 5193，/api 代理到 8091，WS 同样代理）
cd web && npm run dev

# 生产：构建前端后由服务端托管
cd web && npm run build
```

环境变量：`PORT`（服务端口）、`URSI_DATA_DIR`（数据根目录，默认 `~/.ursi`）、`SSH_DB_PATH`（直接指定 SQLite 路径）、`SSH_WEB_STATIC_DIR`（静态目录覆盖，默认 `web/dist`）。

功能边界与验收见 [SPEC.md](SPEC.md)。
