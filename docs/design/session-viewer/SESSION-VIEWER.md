# Session Viewer 工作台设计

一个只读的会话查看器：给定 `sessionId`，在配置的会话目录里找到对应的 Pi JSONL，解析成统一事件后渲染。它作为独立模块部署，todo-web 的工作台区域通过 `workspace-config.json` 的 URL 模板嵌进去。

## 结论先说

- **新建独立模块 `session-viewer/`**，自带 HTTP 服务与静态页面，不依赖 Pi SDK、不需要模型凭据。
- **不复用 `pi-executor/session-service`**：那个服务持有运行中的会话、需要模型配置与读写令牌，只暴露最近 100 条公开消息；本模块要读的是磁盘上的历史文件，两者边界不同。
- **只读、按需解析**：不预加载全量索引内容，只按文件名建 `sessionId → 路径` 索引；单个文件最大 31MB，必须流式读取并分页。
- **格式按「未知即原样收纳」处理**：现存会话至少有两种写法（`session/model_change/message` 与 `queue-operation/user/assistant/last-prompt`），解析器只渲染认识的类型，其余以折叠行显示，不报错、不丢数据。

## 目录结构

```text
session-viewer/
├── SPEC.md                  # 模块规格：功能意图、关键功能、验收
├── README.md                # 启动、环境变量、部署与嵌入说明
├── server/
│   ├── package.json         # Node.js 24，零第三方依赖（node:http + readline）
│   └── src/
│       ├── main.mjs         # HTTP 路由、静态托管、CSP 头
│       ├── config.mjs       # SESSION_ROOTS / PORT / HOST / TOKEN / FRAME_ANCESTORS
│       ├── index.mjs        # sessionId → { path, project, size, mtime }，带 TTL 重建
│       ├── transcript.mjs   # JSONL → 统一事件、分支选择、未知类型收纳
│       └── render.mjs       # 可选：把事件渲染成 HTML 片段（不启用前端打包时用）
├── web/
│   ├── package.json         # React 19 + TypeScript + Vite，产物 out/
│   └── src/
│       ├── main.tsx         # 读取 ?session= 参数
│       ├── api.ts           # 调用 /api 的薄封装
│       ├── Transcript.tsx   # 时间线：消息、思考、工具调用、模型切换、未知条目
│       └── styles.css       # 灰度、衬线标题 + 等宽正文，与 todo-web 一致
└── test/
    ├── fixtures/            # 两份真实结构的脱敏 JSONL（v3 / 另一种写法）
    └── *.test.mjs           # node --test：定位、解析、分页、接口
```

与仓库其他模块一致：模块根放 `SPEC.md` 和 `README.md`，实现分 `server/` 与 `web/`，测试与被测代码同模块。

## 数据源

会话文件位于会话根目录下，路径形如：

```text
<root>/<编码后的 cwd>/[子目录/]<ISO 时间>_<uuid>.jsonl
```

- 根目录由 `SESSION_VIEWER_ROOTS` 指定，逗号分隔，默认 `~/.pi/agent/sessions`。
- 实测 955 个文件、683 个项目目录、755MB，单文件最大 31MB。
- `.jsonl` 每行一个 JSON 对象。已见类型：`session`、`model_change`、`thinking_level_change`、`message`（role 为 `system`/`user`/`assistant`/`toolResult`）、`context_edit`；另一种写法直接是 `queue-operation`、`attribution-snapshot`、`user`、`assistant`、`last-prompt`。
- 条目通过 `id` 与 `parentId` 组成树，最后一条是当前叶子。

## 定位策略

`index.mjs` 在启动时递归遍历根目录（深度上限 3），只读取文件名与 `stat`，按 `/_([0-9a-f-]{36})\.jsonl$/` 提取 `sessionId`：

- 命中多份时取 `mtime` 最新的，并在响应里列出其它候选。
- 索引常驻内存，`sessionId` 未命中或超过 30 秒时重建一次；不监听文件系统事件。
- `sessionId` 先用 UUID 正则校验，不合法直接 400，杜绝路径拼接与 glob 注入。

## HTTP 契约

前缀 `/api`，只读。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /health` | `ok` |
| `GET /sessions/:id` | 元信息：`{ id, project, size, mtime, format, counts, candidates }` |
| `GET /sessions/:id/transcript?limit=200&before=<byteOffset>` | 事件窗口：`{ entries, nextBefore, hasMore, leafId, hasBranches }` |
| `GET /sessions/:id/entry/:entryId` | 单条原始 JSON，供「查看原文」用 |

- `limit` 上限 500，默认 200；`before` 是上一页返回的字节偏移，用于向前翻页。
- 传输前做两件事：文本块截断到 12,000 字符，`system` 消息标记为内部内容，前端默认折叠。

## 解析规则

`transcript.mjs` 输出统一事件，前端只认这一层：

```ts
type Entry =
  | { kind: 'session'; timestamp; cwd?; version? }
  | { kind: 'model'; timestamp; provider?; modelId? }
  | { kind: 'thinkingLevel'; timestamp; level }
  | { kind: 'message'; timestamp; role: 'user'|'assistant'|'toolResult'|'system'; blocks: Block[] }
  | { kind: 'unknown'; timestamp?; type: string; id?: string }

type Block =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'toolCall'; id?; name; input: unknown }
  | { type: 'toolResult'; name?; text?: string; isError?: boolean }
```

分支处理沿用「从叶子沿 `parentId` 回溯」的做法，只渲染当前活动分支；发现同父多子时给出 `hasBranches`，切换分支留到后续版本。未知类型不丢弃，渲染成可展开的 `unknown` 行。

大文件策略：用 `readline` 流式扫描，维护环形缓冲保存最近 `limit` 条，同时记录总字节数；请求带 `before` 时只读到该偏移为止。任何情况下都不把整份文件读进内存。

## 安全与部署

- 默认只监听 `127.0.0.1`，需要局域网访问时显式设 `SESSION_VIEWER_HOST=0.0.0.0`。
- `SESSION_VIEWER_TOKEN` 可选：设置后要求 `Authorization: Bearer`，用于跨网段暴露。
- `SESSION_VIEWER_FRAME_ANCESTORS` 可选：设置后输出 `Content-Security-Policy: frame-ancestors ...`，只允许指定站点嵌入。
- 响应不包含会话目录之外的任何路径；错误信息不带绝对路径。

## 与 todo-web 的接线

todo-web 的工作台已经是 URL 模板宿主，只需配置：

```json
{
  "label": "Session",
  "urlTemplate": "http://127.0.0.1:30150/?session={sessionId}"
}
```

任务里填了 `session_id` 就内嵌对应会话，没填就显示占位说明。两边的耦合只有这一行配置。

## 实施顺序

1. `server/`：定位 + 元信息 + 分页事件接口，配两份 fixture 和接口测试。
2. `web/`：静态页面按 `?session=` 渲染时间线，先支持文本、思考、工具调用、模型切换、未知条目。
3. 索引 TTL、跨根目录去重、`system` 折叠与文本截断的验收测试。
4. 接入 todo-web 工作台配置，验证 iframe 尺寸与滚动。
5. 后续可选：分支切换、SSE 增量刷新、按关键词搜索多个会话。

## 待定

- 是否需要「列出最近会话」的首页，还是只接受 `sessionId`。
- 是否需要解析 `context_edit` 这类压缩标记，还是按未知条目展示。
- 是否需要把 `toolResult` 与对应 `toolCall` 合并成一块展示。
