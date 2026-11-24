# Session Viewer

按 `sessionId` 查找 Pi 会话 JSONL 并渲染成轨迹页面。解析与渲染来自 [`pi-agent-trajectory-viewer`](../../pi-agent-trajectory-viewer)，本模块只做定位、传输、格式兼容与页面外壳。

## 目录

- `server/`：Node.js 24 只读服务，零第三方依赖，负责按文件名定位会话、返回元信息与转换后的文本、托管页面。
- `web/`：React 18 + Vite 页面，读取 `?session=`，调用服务端接口后交给组件库渲染。

## 依赖组件库

组件库在本仓库之外，以 `file:` 依赖引入（`session-viewer/web/package.json` 的 `pi-agent-trajectory-viewer`）。使用前先在组件库仓库构建一次库产物：

```sh
cd /data/dev/pi-agent-trajectory-viewer
npm install
npm run build:lib     # 产出 dist-lib/index.js 与 dist-lib/index.css
```

`web/` 依赖的是 `dist-lib` 里的 ESM 与聚合样式，`exports` 由组件库声明。组件库是 React 18，本页面同样用 18，并在 Vite 里 `dedupe` 了 React，避免出现两份运行时。

## 启动

导出 `web/` 构建产物，再启动服务端：

```sh
cd session-viewer/web && npm ci && npm run build
cd ../server && npm start
```

默认访问 `http://127.0.0.1:30150/?session=<uuid>`；服务端同时托管 `web/dist`。

开发时开两个终端：`cd server && npm start`，另开 `cd web && npm run dev`（`/api` 代理到 `127.0.0.1:30150`，页面端口 5185）。

## 样式

页面配色与看板一致：`web/src/tokens.css` 放看板的灰阶与字体变量，`web/src/theme.css` 把组件库的 `--dsw-*` 主题变量映射过去（圆角归零、品牌色改深灰、状态色降饱和），再用少量 `[data-timeline-span]` 覆盖把时间线色块压成灰阶。加载顺序是组件库 CSS → tokens → theme → shell。

## 嵌入模式

被其他页面以 iframe 嵌入时加 `?embed=1`，页面不再渲染自己的头部（会话 ID、项目、体积、Raw JSONL 那一条），只留轨迹组件，避免和宿主的栏叠成两条：

```text
/?session=<uuid>&embed=1
```

单独打开时保持完整头部。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SESSION_VIEWER_ROOTS` | `~/.pi/agent/sessions` | 会话根目录，逗号分隔 |
| `SESSION_VIEWER_HOST` | `127.0.0.1` | 监听地址，需要局域网时设 `0.0.0.0` |
| `SESSION_VIEWER_PORT` | `30150` | 监听端口 |
| `SESSION_VIEWER_TOKEN` | 空 | 设置后 `/api/*` 需要 Bearer 令牌或 `token` 查询参数 |
| `SESSION_VIEWER_FRAME_ANCESTORS` | 空 | 设置后输出 `Content-Security-Policy: frame-ancestors` |
| `SESSION_VIEWER_WEB_DIR` | `../web/dist` | 静态文件目录 |
| `SESSION_VIEWER_MAX_BYTES` | 64MB | 单文件上限，超过返回 413 |
| `SESSION_VIEWER_INDEX_TTL_MS` | 30000 | 文件名索引有效期 |

## 接口

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/health` | `ok` |
| `GET /api/sessions/:id` | 元信息：项目路径、目录名、大小、修改时间、格式、候选文件 |
| `GET /api/sessions/:id/text` | 转换后的 JSONL 文本，支持 gzip |

转换规则见[设计文档](../docs/design/session-viewer/SESSION-VIEWER.md)：补齐会话头、把老式 `user`/`assistant` 行改写成 `message` 行、丢弃坏行。

## 嵌入看板

在 SUMM-Todo 看板的工作台配置里填：

```json
{ "label": "Session", "urlTemplate": "http://<host>:30150/?session={sessionId}" }
```

任务填了会话 ID 时，折叠任务列表后右侧工作台会内嵌该会话；没填则显示占位说明。

## 检查

```sh
cd server && npm test
cd web && npm run typecheck && npm run build
```
