# Session Viewer 工作台设计

给定 `sessionId`，在配置的会话目录里找到对应 JSONL 并渲染。解析与渲染已经由 `/data/dev/pi-agent-trajectory-viewer` 组件库覆盖，本模块只做组件库没有的那一层：定位、传输、格式兼容、页面外壳、安全与嵌入。

## 组件库已经提供什么

引用 `src/components/index.js` 的导出即可，不再重复实现：

- `parsePiJsonl(text)`：逐行解析、按 `parentId` 选活动分支、构建 `turns`，附带 `header`、`rows`、`stats`。
- `TrajectoryViewer`：工具栏（Duration / Turns / Calls、搜索）、时间线（框选、缩放、平移）、虚拟化记录表格、详情面板（Markdown、JSON、usage、复制）、折叠与选区编排。
- 组件自带主题与结构样式（`src/components/styles/index.css` 聚合，含逐字复制的参考样式）。

因此本模块**不做**服务端解析、不做服务端渲染、不做分页接口：库在浏览器里已经虚拟化列表，服务端切页会破坏时间线、搜索和分支选择。

## 本模块要补的五件事

### 1. 定位：sessionId → 文件

会话目录形如 `<root>/<编码后的 cwd>/[子目录/]<ISO 时间>_<uuid>.jsonl`，根目录由 `SESSION_VIEWER_ROOTS` 指定（逗号分隔，默认 `~/.pi/agent/sessions`）。实测 955 个文件、683 个项目目录、755MB，单文件最大 31MB。

`server/src/locate.mjs` 启动时递归遍历（深度上限 3），只读文件名与 `stat`，按 `/_([0-9a-f-]{36})\.jsonl$/` 建 `sessionId → { path, project, size, mtime }` 索引：命中多份取 `mtime` 最新并把其余列为候选；未命中或索引超过 30 秒时重建。`sessionId` 先过 UUID 正则，不合法直接 400，客户端永远不传路径。

### 2. 传输：把字节和元信息交给页面

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/health` | `ok` |
| `GET /api/sessions/:id` | `{ id, project, size, mtime, format, candidates }` |
| `GET /api/sessions/:id/text` | 会话文本，`text/plain; charset=utf-8`，支持 gzip |

- 上限：默认 64MB，超过返回 413 并提示体积；8MB 以上在页面提示「大会话，解析需要几秒」。
- 用 `createReadStream` 直接管道给响应，不经内存拼接；`format` 标明是否经过兼容转换。

### 3. 兼容转换：把别的写法喂成组件库能吃的形状

`parsePiJsonl` 有两个硬要求：首行必须 `type: "session"`，消息必须是 `type: "message"` 且带 `message.role`。实际库里不只有这种写法（同一批会话里两种风格并存）：

```text
Pi v3：   session / model_change / thinking_level_change / message / context_edit
CC 风格： queue-operation / attribution-snapshot / user / assistant / last-prompt
```

`server/src/canonicalize.mjs` 负责在返回前转换，不改磁盘文件：

- 缺 `session` 头时补一行：`{ type:'session', version:3, id:<sessionId>, timestamp:<首行时间或文件 mtime>, cwd:<解码后的项目目录> }`。
- `type: user|assistant` 且带 `message.role` 的行改写成 `{ type:'message', id:<稳定 id>, parentId:<parentUuid>, timestamp, message }`；`id` 用 `parentUuid + 序号` 派生，保证两次请求一致，避免时间线抖动。
- 其余未知行原样保留：库的 `buildRows` 只处理 `message` 行，未知类型会被忽略，不会报错。
- 转换结果按 `(path, size, mtime)` 缓存到内存；文件变了自动失效。

这一步正是组件库没有的能力：它假定输入是标准 Pi JSONL。

### 4. 页面外壳

`web/` 是一个 React 18 + Vite 的小应用，只做接线：

```text
?session=<uuid>
  → GET /api/sessions/:id（头部信息）
  → GET /api/sessions/:id/text
  → parsePiJsonl(text)
  → <TrajectoryViewer turns={turns} />
```

- 头部显示项目名、cwd、大小、修改时间、来自 `stats` 的 turns/messages/tool 计数。
- 状态：加载中、404（找不到会话）、413（文件过大）、解析失败（附文件路径尾段与错误行号）、空会话。
- 解析放在主线程但用 `startTransition` + 骨架屏；实测超过 1 秒再迁到 Web Worker。
- 引入库的主题 CSS，页面只提供外壳背景与头部，不覆盖组件样式。

### 5. 安全、部署与嵌入

- 默认监听 `127.0.0.1`，需要局域网时设 `SESSION_VIEWER_HOST=0.0.0.0`。
- `SESSION_VIEWER_TOKEN` 可选：设置后要求 `Authorization: Bearer`。
- `SESSION_VIEWER_FRAME_ANCESTORS` 可选：输出 `Content-Security-Policy: frame-ancestors ...`，只允许指定站点嵌入。
- 响应与错误信息都不含会话目录之外的绝对路径。
- todo-web 侧只改一行：`{ "label": "Session", "urlTemplate": "http://127.0.0.1:30150/?session={sessionId}" }`。

## 目录结构

```text
session-viewer/
├── SPEC.md                  # 模块规格：功能意图、关键功能、验收
├── README.md                # 环境变量、启动、部署与嵌入
├── server/
│   ├── package.json         # Node.js 24，零第三方依赖（node:http + readline）
│   └── src/
│       ├── main.mjs         # 路由、静态托管、CSP 与 token
│       ├── config.mjs       # ROOTS / HOST / PORT / TOKEN / FRAME_ANCESTORS / 体积上限
│       ├── locate.mjs       # sessionId → 文件，索引与 TTL
│       └── canonicalize.mjs # 非标准写法 → 组件库可解析的标准 JSONL
├── web/
│   ├── package.json         # React 18 + Vite，依赖组件库
│   └── src/
│       ├── main.tsx         # 读取 ?session= 参数
│       ├── SessionShell.tsx # 头部、状态机、fetch 与 parsePiJsonl
│       └── shell.css        # 只写外壳样式
└── test/
    ├── fixtures/            # 两份脱敏会话：标准 Pi v3、CC 风格
    └── *.test.mjs           # node --test：定位、转换、接口与上限
```

## 依赖组件库的方式

组件库当前是 `private` 应用工程，没有 `exports` 与库构建，直接引用需要先解决分发：

- **方案 A（推荐）**：在组件库仓库补一个库构建（`vite.lib.config.js` 产出 ESM + 聚合 CSS，补 `exports`/`files`），本模块用 `file:` 或 `git+<仓库>#<commit>` 依赖。一次改动，长期干净。
- **方案 B**：把固定 commit 的 `src/components/`、`src/lib/` 复制到 `session-viewer/web/vendor/pi-trajectory/`，配 `scripts/sync-vendor.mjs` 记录来源与 commit。零跨仓构建，但要人工同步。
- 不建议把组件库源码内嵌进 `session-viewer` 主干，那样两边会悄悄分叉。

React 版本也要注意：组件库基于 React 18，todo-web 是 React 19。页面外壳用 18、以 iframe 嵌入，两边各带自己的 React，不共享运行时；这也是继续用「URL + iframe」而不是源码包的原因。

## 实施顺序

1. `server/`：定位、元信息、文本接口 + 两份 fixture 测试。
2. `canonicalize.mjs`：补头与行改写，用 CC 风格 fixture 验证 `parsePiJsonl` 能通过。
3. `web/`：外壳 + 状态机，接通组件库。
4. 体积上限、gzip、token、`frame-ancestors` 的验收。
5. 接入 todo-web 工作台配置，验证 iframe 尺寸与滚动。

## 待定

- 是否保留「最近会话列表」首页，还是只接受 `sessionId`（工作台嵌入只需要后者）。
- 组件库是否接受真实 Pi 会话作为回归样例，避免只测演示数据。
- 31MB 会话在浏览器端的解析耗时与内存，需要实测后再决定是否上 Worker。
