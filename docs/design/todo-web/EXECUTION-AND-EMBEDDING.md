# 执行集成与嵌入形态

看板需要三件事：把执行器安排到某个工作目录里跑任务、给工作目录和执行器各留一个入口、以及能被别的项目整体嵌进去。这三件事的数据归属和实现位置不同，分开设计。

## 结论

- **执行能力不在看板实现。** 执行器修订、后端登记、ACP 进程、尝试、事件和只读制品都由[执行器平台](../../../docs/design/executor-platform/OVERVIEW.md)拥有。看板只做「提交 + 只读展示」，实现方式是服务端做平台的 HTTP 消费者。
- **不新建 `workspaces` 表。** 待办库由 SUMM-Todo CLI 建表和迁移，看板只读写现有列。工作目录沿用 `projects.path`，任务上的 `workspace` 字段是自由字符串标注，指向目录而不是目录实体。需要多目录或目录策略时，再讨论在看板自己的存储里建实体，仍然不碰待办库。
- **执行器管理页不重复做。** 看板里只放「给这次执行选一个已发布修订」的选择器，数据由服务端代理平台的只读接口；登记后端、试跑、发布、停用仍在平台管理页。
- **尝试关联存看板自己的存储**，不写待办库。任务与尝试是一对多，用 append-only 记录，唯一真相仍是平台的尝试状态。
- **被嵌入的能力分两步走。** 近期维持「独立部署 + 链接/iframe」，等确实出现宿主需求再抽源码包 `todo-web-kit`。执行详情这类外部页面继续用已实现的 URL 模板 + iframe。

## 职责与数据归属

| 数据 / 操作 | 归属 | 说明 |
| --- | --- | --- |
| 任务、项目、目录路径 | 看板（待办库） | 现有 `tasks`、`projects` 表，只加列不改结构 |
| 工作目录「选哪个」 | 看板 | 取 `projects.path`，任务用 `workspace` 标注具体子目录 |
| 提交执行、取消、查状态 | 看板服务端 | 作为平台消费者，令牌只在服务端 |
| 尝试、事件、制品、修订、后端 | 执行器平台 | 看板只读镜像状态，不落第二份真相 |
| 尝试与任务的关联 | 看板自己的存储 | 单独文件，append-only |
| 执行器登记、试跑、发布 | 平台管理页 | 看板不提供编辑入口 |

## 数据模型

看板自己的存储（例如 `$TODO_WEB_DATA/state.db`，与待办库分开）只放一张关联表：

```sql
CREATE TABLE task_attempts (
  attempt_id   TEXT PRIMARY KEY,   -- 小写标准 UUID，看板生成
  task_id      TEXT NOT NULL,      -- 待办库里的任务 ID（8 位十六进制）
  workdir      TEXT,               -- 提交时的工作目录快照
  executor_id  TEXT NOT NULL,
  revision     INTEGER NOT NULL,
  state        TEXT NOT NULL,      -- 镜像平台状态 + unverified
  submitted_at TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX task_attempts_task ON task_attempts(task_id, submitted_at DESC);
```

- 不在 `tasks` 上加 `attempt_id`：一个任务会跑多次，覆盖式写入会丢掉历史。
- `executorRef` 只在提交时冻结进尝试，不挂在目录上；同一目录不同任务可以选不同修订。
- 任务状态仍由人通过 `todo_core::Task::transition` 推进，**不从尝试状态反推**。
- `tasks.session_id` 保留用户标注的语义（例如对应哪次会话），平台内部 journal 的 session 是平台私有数据，看板不保存它。

## 一次执行怎么走

1. 前端在看板里对某个任务点「执行」，带上工作目录、指令、选中的 `executorRef`。
2. 看板服务端先用自己的存储生成小写 UUID 并落库，再以该 ID 提交平台。回执丢失时用同一 ID 查询，不重发新任务；同 ID 同请求查回原尝试，改动请求返回 409，由人决定，不自动换 ID。
3. 平台按冻结配置启动 worker。看板只轮询 `GET /executor-attempts/{id}`：终态是在后续查询里才发布的，客户端计时器不能判失败。
4. 取消只登记意图，结果仍以查询为准；没有终态证据的状态显示为 `unverified`。
5. 拿到终态后，用平台的只读目录接口列制品、读正文，渲染在任务详情或工作台里。

## 安全前提

看板当前没有鉴权，监听 `0.0.0.0`，局域网内任何人都能改数据。**在打开「提交执行」之前必须先做访问控制**，否则等于把昂贵的 Agent 执行能力开放给整个网段：

1. 看板服务端加只读 / 可写两档令牌或来源限制，写操作至少限制在本机与反向代理之后。
2. 平台目前只认识 workbench 与 runtime 两个角色，跨角色一律 404。看板要么新增第三角色（需要改平台 SPEC 与令牌校验），要么复用专门为看板签发的角色。**不要复用 Workbench 令牌**，那会破坏归属隔离。
3. 执行器令牌只出现在服务端配置里，浏览器永远拿不到。

## 能被别的项目嵌入

### 形态一：看板作为独立应用被链接或内嵌

保持现在的独立构建与部署，别的项目通过链接进入，或在页面里放 `iframe`。零构建耦合，鉴权仍由看板自己处理。适合「另一个项目只是需要一个入口」。

### 形态二：抽源码包 `todo-web-kit`（按需，后置）

当宿主需要把任务面板放进自己的布局、共享登录和主题时，再抽包：

- 复用仓库存量约定：`file:` 依赖加 `ursi-source` 导出条件，宿主直接编译源码（先例 `@ursi/mcp-web` 被 Workbench 引用）。
- 只导出无路由的 `TodoTaskPanel`、`TodoWorkspacePanel`，不导出带全局路由的应用；宿主给容器、给凭证、给初始任务。
- props 收敛到 `apiBaseUrl`、`auth`（请求头或 `credentials`）、`taskId` 与 `onTaskSelect`、`storageKey`、`onNotify`。
- 抽包前必须先清理阻碍嵌入的东西：`@/` 别名、全局 CSS 重置与 `html/body` 规则、单例 store、全局 `keydown`、`alert/prompt`、硬编码的 `/api` 与 `/workspace-config.json` 路径。样式用容器类加 `@layer`，必要时用 Shadow DOM。
- react / react-dom 转为 peerDependencies，宿主设置 `dedupe`，避免两份 React。

### 形态三：执行详情这类外部页面

已经在用 URL 模板 + iframe：`public/workspace-config.json` 配 `urlTemplate`，占位符 `{id}`、`{project}`、`{workspace}`、`{sessionId}`。这条路径继续保留，它和执行集成是互补的：看板负责「提交与状态」，外部页面负责「看轨迹」。

补充两点：`sandbox` 同时给 `allow-scripts` 与 `allow-same-origin` 时，同源页面等于没隔离，模板要限制 origin 白名单；跨源鉴权不要在 URL 里放令牌，用宿主反向代理转到同源。

## 页面归属

| 页面 | 位置 | 内容 |
| --- | --- | --- |
| 任务与详情 | 看板（已有） | 任务、备注、尝试列表、最新制品 |
| 工作目录 | 看板 | 复用项目编辑面板维护 `path`，任务用 `workspace` 标注子目录；不新增实体页 |
| 执行器 | 执行器平台管理页 | 登记、试跑、发布、停用；看板只提供选择器与深链 |
| 运行详情 | 平台事件页或外部页面 | 看板嵌 `iframe` 或只读呈现制品 |

## 分期

- **P1（只读）**：看板自己的 attempt 关联表 + 服务端 `GET` 代理 + 任务详情只读展示尝试与制品。修订从配置读，不做选择 UI。
- **P2（提交）**：先加看板鉴权，再接 `PUT` 提交、轮询、取消；失败与 409 人工介入。
- **P3（选择器）**：服务端代理平台 `/executors`，前端给每个工作目录或每次执行选修订。
- **P4（嵌入）**：按宿主需求抽 `todo-web-kit`，同时清理全局样式与单例。

## 不做的事

- 不在看板里实现 ACP 执行、制品收集或后端登记。
- 不复制 Workbench 的执行器客户端（`workbench/server/src/work/executor` 约千行）；真要复用，先抽共享 crate，两处共用一份协议实现。
- 不在待办库里加表、加迁移。
- 不让尝试状态驱动任务状态。
