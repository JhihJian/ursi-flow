# 仓库说明

ursi-flow 是一个 npm workspaces 单仓，装着若干可独立部署的 Web 应用与一个工作区外壳。每个应用自带服务端与前端，模块之间不互相 import，跨模块协作只在组合根接线。

## File Map

| 路径 | 内容 |
| --- | --- |
| `SPEC.md` | 根规格：项目意图与跨应用验收条件 |
| `ARCHITECHTURE.md` | 模块职责、模块关系、设计索引。新增设计必须先在此登记 |
| `package.json` | 根 workspaces 与跨应用脚本 |
| `apps/<应用>/` | 单个应用，命名见下表 |
| `apps/<应用>/SPEC.md` | 模块功能与验收，契约以它为准 |
| `apps/<应用>/README.md` | 运行方式、环境变量、接口说明 |
| `apps/<应用>/web/` | React 前端，导出 `./module` 接入工作区外壳 |
| `apps/<应用>/server/` | 同源 API 与静态托管，零依赖 Node 或 Rust |
| `apps/shell-web/` | 工作区外壳入口，组合根是 `src/registry.tsx`，代理表是 `vite.config.ts` |
| `apps/ursi-flow/` | Flow 交付包，内含 `core/`、`executor/`、`runtime/` 三个子模块，各有 SPEC |
| `packages/workspace-shell/` | 外壳骨架与模块契约，接入新模块读 `MODULE-CONTRACT.md` |
| `docs/design/<模块>/` | 设计文档，按所属模块分组 |
| `docs/design/deployment/DEPLOYMENT.md` | 单机部署方案：入口路由、构建发布、存储清理与卸载 |
| `deploy/` | 部署实现：`Caddyfile.tmpl`、`units/*.service`、`deploy.sh`、`prune.sh`、`uninstall.sh`、`deploy.env.example` |
| `AGENTS.md` | 本文件：目录地图、模块索引、命令与约定 |

## 模块索引

| 模块 | 规格 | 设计文档 |
| --- | --- | --- |
| 工作区外壳 | `packages/workspace-shell/SPEC.md` | `packages/workspace-shell/MODULE-CONTRACT.md` |
| 工作台入口 | `apps/shell-web/README.md` | `docs/design/deployment/DEPLOYMENT.md` |
| SUMM-Todo 看板 | `apps/todo-web/SPEC.md` | `docs/design/todo-web/DASHBOARD.md`、`WORKSPACE-SHELL.md` |
| SSH 终端 | `apps/ssh-web/SPEC.md` | `docs/design/ssh-web/WORKSPACE-INTEGRATION.md` |
| 文件管理器 | `apps/fs-web/SPEC.md` | 见 README |
| dae 路由观察台 | `apps/dae-web/SPEC.md` | `docs/design/dae-web/OVERVIEW.md` |
| Flow 工作台 | `apps/flow-web/SPEC.md` | `apps/flow-web/README.md` |
| Flow Core / Runtime / 能力 | `apps/ursi-flow/core/SPEC.md`、`runtime/SPEC.md` | `docs/design/flow-runtime/` |
| Pi 管理台 | `apps/pi-manager-web/SPEC.md` | `apps/pi-manager-web/docs/settings-alignment.md` |
| Pi 会话浏览 | `apps/pi-sessions-web/SPEC.md` | `apps/pi-sessions-web/server/HTTP.md` |
| Pi 交互对话 | `apps/pi-chat-web/SPEC.md` | `docs/design/pi-chat-web/CHAT.md` |
| MCP 服务管理 | `apps/mcp-web/SPEC.md` | `docs/design/mcp-web/RECOGNITION-RULES.md` |
| 沙箱平台 | `apps/ursi-sandbox/SPEC.md` | `docs/design/ursi-sandbox/` |
| 单机部署 | `docs/design/deployment/DEPLOYMENT.md` | `deploy/` 下的模板与脚本 |

## 命令

```sh
npm install                     # 根目录装一次，建立 workspaces 链接
npm run dev:shell-web           # 工作区开发入口 http://localhost:5191
npm run build:shell-web         # 构建入口静态产物
npm run build:ursi-flow         # flow-web 服务端依赖的引擎产物
npm run test:todo-web
npm run test:flow-web
npm run test:ursi-flow

cargo build --release --manifest-path apps/todo-web/Cargo.toml
cargo build --release --manifest-path apps/ssh-web/Cargo.toml

deploy/deploy.sh                # 构建、渲染配置、安装单元、重启、冒烟
deploy/prune.sh                 # 报告可回收占用，加 --apply 执行
deploy/uninstall.sh             # 卸载，默认保留数据与构建产物
```

## 约定

- 模块之间不互相 import。跨模块调用由组合根 `apps/shell-web/src/registry.tsx` 用命令与普通值接线，删掉某个模块时组合根要编译失败，不能留运行期悬空调用。
- 新增工作区模块要同时改四处：`apps/shell-web/package.json` 的依赖、`src/registry.tsx` 的模块清单与 profile、`vite.config.ts` 的代理、`deploy/Caddyfile.tmpl` 的入口路由。只改前三处会出现在开发期可用、部署后 404 的模块。
- 新增设计放进 `docs/design/<模块>/`，并在 `ARCHITECHTURE.md` 的设计索引里登记一行。
- 端口只由部署配置决定。各服务的默认端口属于独立启动行为，部署时从 `deploy/deploy.env` 覆盖。
- 服务端保持单一职责：只做该模块的 API 与静态托管，不启动其他应用、不共享数据库连接。
- 零依赖 Node 服务是既有风格：能直接跑 `.ts` 就不引入框架，新依赖要说明理由。
- 应用层不做鉴权，安全边界是可信局域网加单一入口。跨出可信网络时由前置代理统一认证，不要在单个模块里加来源判断。

## 数据与部署

- 所有运行期写入集中在 `URSI_HOME`（默认 `~/.ursi`）。新增状态文件要用环境变量指定位置并落在该根目录下，不写到 `~/.local/state`、`~/.cache` 等分散位置。
- `~/.pi/agent` 是与 pi CLI 共用的 pi home，保持原位，不并入 `URSI_HOME`。
- 构建产物留在仓库树内，不入库、不进 `URSI_HOME`。clean 与卸载规则见 `docs/design/deployment/DEPLOYMENT.md`。

## Git

- 一次提交只包含本次改动的文件，提交前用 `git status` 核对。
- 提交信息用中文，首行说清做了什么，正文只写必要的动机与影响。
- 改动模块行为时同步改该模块的 SPEC 或 README；改动部署方式时同步改 `docs/design/deployment/DEPLOYMENT.md`。
