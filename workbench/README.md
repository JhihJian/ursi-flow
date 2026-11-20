# 工作台开发入口

工作台由 [Server](server/README.md) 和 [Web](web/README.md) 组成。Server 提供 API，Web 在开发时通过 Vite 将同源 `/api` 请求转发给 Server。`workbench/` 是 Cargo 工作区根目录，`web/` 使用自己的 npm 锁文件。请从完整仓库检出构建，Server 编译时依赖仓库内的 [Flow SDK](../flow-runtime/client/README.md)。

## 本地开发

以下命令从 `workbench/` 执行。先在服务环境中设置 `URSI_API_TOKEN`。只使用工作清单时可关闭 Flow：

```sh
URSI_FLOW_ENABLED=0 cargo run --locked -p ursi-server
```

另开终端，在 `workbench/` 下启动 Web（Node.js 24）：

```sh
cd web
npm ci
npm run dev
```

原先从仓库根启动的实例如需沿用原数据和受信工作目录，请将 `URSI_DATA_DIR`、`URSI_WORKSPACE_DIR` 显式设为原目录的绝对路径。两者的默认值均与启动目录有关。

## 目录编辑台

从「工作包」进入 `/work-patches`，输入包名后直接整理文件。从「配置包」进入 `/config-patches`，分别编辑 `AGENTS.md`、`skills/` 和 `mcp.json`。包记录只保存名称、标识和 `directoryId`。也可以不建包，直接 `POST /api/v2/directories` 创建虚拟目录，再用返回的 ID 读写文件。见[目录接口](server/src/work/directories/HTTP.md)和[模块分工与交互对照](PATCH-STUDIO.md)。

## 派工与办理

从工作清单打开「发起工作」（`/items/new`），选择已发布的派工模板及其修订。管理员通过 `/api/v2/packages` 发布模板，外部来源也可按配置指定模板和动作。工作项固定开单时的办理说明和验收标准，模板更新不影响已创建的工作项。

## 检查

```sh
cargo test --locked --workspace
(cd web && npm run check)
```

[派工与办理联合验收](web/acceptance/README.md)和[工作包与配置包联合验收](web/patches-acceptance/README.md)均使用工作台构建的 Server 和 Web。Flow 和本地 Agent 的运行条件见 [Server 使用说明](server/README.md)。
