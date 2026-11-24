---
parent: ../SPEC.md
references:
  - README.md
  - ../docs/design/session-viewer/SESSION-VIEWER.md
---

# 会话查看工作台

## 功能意图

按 `sessionId` 在配置的会话目录里找到 Pi 会话 JSONL 并渲染成可浏览的轨迹，供其他界面（例如 SUMM-Todo 看板的工作台区域）嵌入。解析与渲染由 `pi-agent-trajectory-viewer` 组件库负责，本模块只提供定位、传输、格式兼容、页面外壳与访问控制。

## 关键功能与验收

### 按 sessionId 定位会话

#### 验收

- 服务启动时只扫描 `SESSION_VIEWER_ROOTS` 下三层目录的文件名与大小，不读取文件内容；索引超过 30 秒或未命中时重建。
- 文件名形如 `<时间>_<uuid>.jsonl` 或 `<uuid>.jsonl` 都能命中。同一 ID 有多份时取修改时间最新的一份，其余列为候选。
- ID 不是 UUID 时返回 400，不存在时返回 404；客户端无法指定路径。

### 把会话内容交给组件库

#### 验收

- `GET /api/sessions/:id` 返回 ID、项目路径、原始目录名、字节数、修改时间、格式判断与候选文件。
- `GET /api/sessions/:id/text` 以 `text/plain` 流式返回内容，支持 gzip；超过体积上限返回 413 并说明实际大小。
- 内容经过兼容转换：缺少 `type: "session"` 头时按首行时间、`cwd`、`sessionId` 合成；`user`/`assistant` 行改写成 `message` 行并保留 `uuid`/`parentUuid` 的父子关系；坏行丢弃并计数，重复头只保留一条。
- 组件库能直接解析转换结果：标准 Pi 会话与老式 `queue-operation`/`user`/`assistant` 会话都能渲染出轨迹。

### 浏览页面

#### 验收

- 打开 `/?session=<uuid>` 显示会话头部（项目、大小、修改时间、格式、turns/messages/tools 计数）与组件库的轨迹视图。
- 缺少参数、找不到会话、超过体积上限、解析失败分别显示对应说明，并给出原始 JSONL 链接。
- 会话体积超过 8MB 时提示解析需要几秒。

### 部署与嵌入

#### 验收

- 默认只监听 `127.0.0.1`；设置 `SESSION_VIEWER_HOST=0.0.0.0` 后才对外提供。
- 设置 `SESSION_VIEWER_TOKEN` 后 `/api/*` 需要 Bearer 令牌或 `token` 查询参数；设置 `SESSION_VIEWER_FRAME_ANCESTORS` 后只允许列出的源嵌入。
- 看板只需在 `workspace-config.json` 里把 `urlTemplate` 指向 `/?session={sessionId}`，任务填了会话 ID 时工作台内嵌该会话。
