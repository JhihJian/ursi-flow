# 仓库说明

ursi-flow 是 npm workspaces 单仓：多个可独立部署的 Web 应用加一个工作区外壳。模块之间不互相 import，跨模块只在组合根接线。

## File Map

| 路径 | 内容 |
| --- | --- |
| `SPEC.md` | 根规格与跨应用验收 |
| `ARCHITECHTURE.md` | 模块职责、关系与设计索引，新增设计在此登记 |
| `apps/<应用>/` | 应用本体：`SPEC.md` 是验收，`README.md` 是运行方式，`web/` 导出 `./module`，`server/` 提供同源 API |
| `apps/shell-web/` | 工作区入口，组合根 `src/registry.tsx`，开发代理 `vite.config.ts` |
| `apps/ursi-flow/` | Flow 交付包，`core/`、`executor/`、`runtime/` 各有 SPEC |
| `packages/workspace-shell/` | 外壳骨架与模块契约 |
| `docs/design/<模块>/` | 设计文档 |
| `docs/design/deployment/DEPLOYMENT.md` | 单机部署方案：路由、构建发布、存储清理、卸载 |
| `deploy/` | `Caddyfile.tmpl`、`units/`、`deploy.sh`、`prune.sh`、`uninstall.sh`、`deploy.env.example` |
| `AGENTS.md` | 本文件 |

## 命令

```sh
npm install
npm run dev:shell-web      # 开发入口，5191
npm run build:shell-web    # 入口静态产物
npm run build:ursi-flow    # flow-web 依赖的引擎产物
npm run test:todo-web      # 另有 test:flow-web、test:ursi-flow
cargo build --release --manifest-path apps/{todo,ssh}-web/Cargo.toml

deploy/deploy.sh           # 构建、渲染配置、安装单元、重启、冒烟
deploy/prune.sh            # 报告可回收占用，--apply 执行
deploy/uninstall.sh        # 卸载，默认保留数据与构建产物
```

## 约定

- 新增工作区模块要同时改四处：`shell-web` 的 `package.json`、`registry.tsx`、`vite.config.ts`、`deploy/Caddyfile.tmpl`。少改会出现开发期正常、部署后 404。
- 新增设计放进 `docs/design/<模块>/`，并在 `ARCHITECHTURE.md` 的设计索引登记。
- 运行期写入统一落在 `URSI_HOME`（默认 `~/.ursi`）；`~/.pi/agent` 与 pi CLI 共用，保持原位；构建产物留在仓库树内。
- 服务端只做本模块的 API 与静态托管。零依赖 Node 是既有风格，新依赖要说明理由。
- 应用层不做鉴权，边界是可信局域网加单一入口；跨出可信网络时由前置代理统一认证。
- 改模块行为同步 SPEC 或 README，改部署方式同步 `DEPLOYMENT.md`。

## Git

- 只提交本次改动的文件，提交前用 `git status` 核对。
- 提交信息用中文，首行说清做了什么，正文只写必要动机。
