# 仓库说明

ursi-flow 是 npm workspaces 单仓：多个可独立部署的 Web 应用（`apps/<应用>`）加一个工作区外壳（`apps/shell-web/`）。模块边界、数据归属与部署方式以 `ARCHITECHTURE.md`、各模块 `SPEC.md` 和 `docs/design/` 为准，本文件只做导航。

## File Map

| 路径                                     | 内容     |
| -------------------------------------- | ------- |
| `docs/design/deployment/DEPLOYMENT.md` | 单机部署方案 |

## 工作约定

- 改模块行为同步该模块的 `SPEC.md` 或 `README.md`；改部署方式同步 `DEPLOYMENT.md`；新增设计在 `ARCHITECHTURE.md` 的设计索引登记。
- 模块之间不互相 import，跨模块协作走组合根。
- 除非特别许可，项目根目录下不准新建文件或目录