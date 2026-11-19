# 派工基线记录

本文件记录 Web v2 并行派工所依据的工作树基线，供各工作包负责人复现和对照。

## 基线内容

基线提交为 `main` 上「记录 Web v2 派工基线」这一次提交，来自设计基线 `e59e86c` 加暂停时的前端草稿。纳入基线的内容：

- 已跟踪修改：`web/src/app/{AppShell,LoginGate,NotFoundView}.tsx`、`AppShell.test.tsx`、`router.tsx`、`router.test.tsx`、`SPEC.md`，`web/src/shared/SPEC.md`，`web/src/shared/http/{client.ts,client.test.ts}`，`web/vite.config.ts`。
- 未跟踪文件：`web/src/app/{AppSidebar.tsx,navigation.ts}`、`web/src/modules/{definitions,sources,work-detail,work-list}/`、`web/plans/`。

基线提交时实测：`npm run lint`、`npm run typecheck`、`npm run test`（12 个文件 73 用例）和 `vite build` 均通过。草稿原有的三处编译错误和一条 `react-hooks/set-state-in-effect` 已在基线提交「修复派工页底稿的编译与状态初始化」中最小化修正（请求标识改用 `dispatch.ts`、布尔布尔默认值改为派生），派工页的真实点击、重试与防重行为仍归 03 工作包重做。

## 并行分工

| 工作包 | 分支 | 工作目录 |
| --- | --- | --- |
| 01 工作台入口 | `web-v2/01-shell` | `/data/dev/ursi-flow-worktrees/v2/01-shell` |
| 02 定义发布 | `web-v2/02-definitions` | `/data/dev/ursi-flow-worktrees/v2/02-definitions` |
| 03 内置派工 | `web-v2/03-dispatch` | `/data/dev/ursi-flow-worktrees/v2/03-dispatch` |
| 04 来源派工 | `web-v2/04-sources` | `/data/dev/ursi-flow-worktrees/v2/04-sources` |
| 05 办理与验收 | `web-v2/05-work-item` | `/data/dev/ursi-flow-worktrees/v2/05-work-item` |
| 06 联合验收 | `web-v2/06-acceptance` | 在各包合并后从 `main` 起 |

各工作目录通过符号链接共用主工作树的 `web/node_modules`，不重复安装依赖。所有包均从同一次基线提交起，合并顺序为 01 → 02 → 03 → 04 → 05 → 06。
