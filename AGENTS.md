# 仓库说明

ursi-flow 是 npm workspaces 单仓：多个可独立部署的 Web 应用加一个工作区外壳。模块边界、数据归属与部署方式以 `ARCHITECHTURE.md`、各模块 `SPEC.md` 和 `docs/design/` 为准，本文件只做导航。

## File Map

| 路径 | 内容 |
| --- | --- |
| `SPEC.md` | 根规格与跨应用验收 |
| `ARCHITECHTURE.md` | 模块职责、关系与设计索引 |
| `apps/<应用>/` | 应用本体，`SPEC.md` 是验收，`README.md` 是运行方式 |
| `apps/shell-web/` | 工作区入口与组合根 |
| `apps/ursi-flow/` | Flow 交付包 |
| `packages/workspace-shell/` | 外壳骨架与模块契约 |
| `docs/design/<模块>/` | 设计文档 |
| `docs/design/deployment/DEPLOYMENT.md` | 单机部署方案 |
| `deploy/` | 部署用的模板、单元与脚本 |
| `AGENTS.md` | 本文件 |

## 工作约定

- 改模块行为同步该模块的 `SPEC.md` 或 `README.md`；改部署方式同步 `DEPLOYMENT.md`；新增设计在 `ARCHITECHTURE.md` 的设计索引登记。
- 模块之间不互相 import，跨模块协作走组合根。
- 文件地图与真实目录不一致时更新这里。

## Git

- 只提交本次改动的文件，提交前用 `git status` 核对。
- 提交信息用中文，首行说清做了什么。
