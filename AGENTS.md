# 仓库说明

ursi-flow 是 npm workspaces 单仓：多个可独立部署的 Web 应用（`apps/<应用>`）加一个工作区外壳（`apps/shell-web/`）。模块边界、数据归属与部署方式以 `ARCHITECHTURE.md`、各模块 `SPEC.md` 和 `docs/design/` 为准，本文件只做导航。

## File Map

| 路径                                     | 内容     |
| -------------------------------------- | ------- |
| `docs/design/location/URI-CONTRACT.md`  | 基座与位置契约的设计取舍 |
| `docs/design/deployment/DEPLOYMENT.md` | 单机部署方案 |

## 基座与契约

多个模块共用的东西，做成契约，不做成服务。

- **基座是一组契约，不是一个服务。** 没有基座进程，没有基座数据库，各模块照旧独立部署、独立持有数据。基座只提供纯函数与约定，落在 `packages/` 下，前后端都能引用。
- **契约只解决「各模块缺一个共同的说法」，不替任何模块保管事实。** 设备清单归 ssh-web 的连接表，目录清单归 fs-web 的状态文件，pi 的 home 清单归 pi-web。集中存一份只是复制，复制出来的那份迟早与原件不一致。
- **一旦有了基座服务，模块就会把它当公共数据库**，把本该自己管的事实放进去，模块边界慢慢失效。多一个有状态的进程，就多一个要备份、要迁移、要排障的东西。
- **跨模块传目录用位置契约的 URI**（`file:///abs/path`、`ssh://<设备>/abs/path`），不传裸路径。它是身份不是传输层，也不是存储键。定义见 `packages/location/SPEC.md`，取舍见 `docs/design/location/URI-CONTRACT.md`。
- **跨模块能力由组合根注入。** 接收方由工厂导出具名 `commands`，发送方在自己的选项里声明它需要的函数类型，组合根把两端接上。模块之间不互相 import，也不共享 store 或 API 对象。规范见 `packages/workspace-shell/MODULE-CONTRACT.md` 第 8 节。

## 工作约定

- 改模块行为同步该模块的 `SPEC.md` 或 `README.md`；改部署方式同步 `DEPLOYMENT.md`；新增设计在 `ARCHITECHTURE.md` 的设计索引登记。
- 新增共用能力时先问「这是契约还是服务」：只是共同的说法就做成 `packages/` 下的纯函数包，确有状态才考虑服务，且该状态必须有一个明确的归属模块。
- 除非特别许可，项目根目录下不准新建文件或目录