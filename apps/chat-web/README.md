# chat-web

AI 对话应用：基于 shadcn chatbot-template 改造，视觉风格对齐 todo-web（黑白灰单色、等宽字体、面板式布局），后端经 Vercel AI Gateway 流式对话，无 Web 框架。

## 运行

```sh
# 依赖（根目录 workspaces）
npm install

# 服务端（Node 24 直跑 TS，默认 0.0.0.0:8198）
AI_GATEWAY_API_KEY=xxx npm run start -w @ursi/chat-web-server

# 前端（开发模式，Vite 把 /api 代理到 127.0.0.1:8198）
npm run dev -w @ursi/chat-web        # http://localhost:5183

# 生产：构建后由服务端托管 web/dist
npm run build -w @ursi/chat-web
npm run start -w @ursi/chat-web-server  # http://localhost:8198
```

`AI_GATEWAY_API_KEY` 来自 Vercel AI Gateway。模型清单见 `server/src/models.ts`，客户端选择器在 `web/src/lib/models.ts` 保持同名。

## 关键决策

### 服务端：Node 原生 http + Node 类型剥离（.ts 直跑）

与 fs-web 一致，不引入 Web 框架，`node:http` 直写路由。端点：

- `POST /api/chat`：接收 AI SDK UI message 流（`useChat` 默认端点），`validateUIMessages` 校验形状后 `streamText`，经 `createUIMessageStreamResponse` 回 SSE。客户端断开即 `AbortController` 中止生成，避免空耗额度。
- `GET /health`：存活探针。
- `GET /`：托管 `web/dist`（SPA fallback），`CHAT_WEB_STATIC_DIR` 可覆盖目录。

消息流为 AI SDK 的 UI message 格式（text / reasoning / tool-* / source-url part），前端用 `@ai-sdk/react` 的 `useChat` 消费，服务端只负责转发到模型与执行工具。

### 工具

三个工具，均经 AI Gateway 的模型调用，`stopWhen: isStepCount(5)` 限制单次步数：

- `github_repo`：查 GitHub 仓库统计（stars/forks/issues/language），失败返回 `{ error }` 而非抛错。
- `ask_user`：把模糊请求转成问卷（每题 3 个选项 + 自由输入），流式 `input-available` 后前端弹 `QuestionCard`，用户作答 `addToolOutput` 续跑。未作答的问题不进消息 Trace，由卡片单独渲染。
- `web_search`：按模型厂商注入（`anthropic.tools.webSearch_20260209` / `openai.tools.webSearch`），来源 `source-url` part 聚合去重展示。

### 前端：视觉对齐 todo-web，不复用 shadcn Tailwind

模板原为 shadcn/ui + Tailwind，这里全部改写为 todo-web 的黑白灰风格：`--black/--gray-*` 变量、`--font-mono` 等宽字体、13px、隐藏滚动条、面板与 1px 分隔线。UI 组件（button/message/trace/code-block/collapsible/alert/empty）自写，图标用 `@remixicon/react`，无 Tailwind、无 shadcn 运行时。

代码块高亮用 `shiki` 按需加载语言（`lib/highlighter.tsx`），流式只 tokenize 新增行并保留语法状态（`hooks/use-highlighted-code.ts`）。

## 代码结构

```
chat-web/
├── server/                 # 服务端（Node 24 直跑 TS，无 Web 框架）
│   └── src/
│       ├── models.ts        # 模型清单 + 允许校验
│       ├── tools/           # github_repo / ask_user / web_search
│       └── server.ts        # node:http 路由 + UI message 流 + 静态托管
└── web/
    └── src/
        ├── api/types.ts     # UI message part 类型（与服务端工具形状对齐）
        ├── lib/             # 模型清单 / 高亮器 / 工具函数
        ├── hooks/           # 流式代码高亮
        ├── components/      # chat / message / parts / ui 组件
        └── App.tsx / styles.css
```

## 安全

`/api/chat` 公开且按请求消耗 AI Gateway 额度，仅做单请求模型与消息校验。暴露给真实流量前应加限流、鉴权与额度上限。
