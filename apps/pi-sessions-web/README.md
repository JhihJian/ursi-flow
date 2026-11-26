# Pi 会话浏览

按磁盘上的会话目录渲染 pi 会话：左侧按项目分组列出会话，右侧用 [`pi-agent-trajectory-viewer`](../../../pi-agent-trajectory-viewer) 渲染轨迹。

会话目录由使用者在界面里指定，任意绝对路径都行：`~/.pi/agent/sessions`、它的上一级 `~/.pi/agent`、某个项目的单目录、别人的导出备份。模块只读会话文件，不启动 pi，不写任何会话内容。

## 目录

- `server/`：Node.js 24 只读服务，零第三方依赖。扫描目录、按 id 定位、把会话转成组件库认的形状、托管页面。接口契约见 [`server/HTTP.md`](server/HTTP.md)。
- `web/`：React 18 + Vite 页面，样式沿用 `apps/todo-web` 的灰阶 token 与两栏骨架。

## 依赖组件库

组件库在本仓库之外，以 `file:` 依赖引入（`web/package.json` 的 `pi-agent-trajectory-viewer`）。使用前先在组件库仓库构建一次库产物：

```sh
cd /data/dev/pi-agent-trajectory-viewer
npm install
npm run build:lib     # 产出 dist-lib/index.js 与 dist-lib/index.css
```

组件库是 React 18，本页面同样用 18，并在 `vite.config.ts` 里 `dedupe` 了 React，避免出现两份运行时。

## 启动

导出 `web/` 构建产物，再启动服务端：

```sh
cd web && npm install && npm run build
cd ../server && npm start
```

默认访问 `http://<本机地址>:30200/`，服务端同时托管 `web/dist`。

开发时开两个终端：`cd server && npm start`，另开 `cd web && npm run dev`（`/api` 代理到 `127.0.0.1:30200`，页面端口 5186）。

## 环境变量

全部可选，服务端读取：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PI_SESSIONS_HOST` | `0.0.0.0` | 监听地址。默认所有网卡以便局域网直接打开；只想本机用时设成 `127.0.0.1` |
| `PI_SESSIONS_PORT` | `30200` | 监听端口 |
| `PI_SESSIONS_ROOT` | `~/.pi/agent/sessions` | 界面初始根目录 |
| `PI_SESSIONS_MAX_BYTES` | `67108864` | 单个会话文本上限，超过返回 413 |
| `PI_SESSIONS_STATE` | `~/.cache/pi-sessions-web/session-index.json` | 扫描索引落盘位置 |
| `PI_SESSIONS_WEB_DIR` | `../web/dist` | 静态页面目录 |

前端开发用 `PI_SESSIONS_API` 指定代理目标，默认 `http://127.0.0.1:30200`。

## 测试

```sh
cd server && npm test    # node --test：扫描、接口、索引落盘
cd web && npm test       # vitest：格式化与分组等纯函数
cd web && npm run typecheck
```

## 与既有模块的关系

- `apps/pi-web` 是完整的 Pi Web UI，带 agent 运行时；本模块只读历史会话，用于翻阅与复核，两者不共享代码。
- `session-viewer` 按 `sessionId` 在服务端预先配置的目录里找单个会话，供看板嵌入；本模块在浏览器里指定根目录并浏览整批会话，定位方式与会话转换规则保持一致（`server/src/canonicalize.mjs` 与它同源）。
