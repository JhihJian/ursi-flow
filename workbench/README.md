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

## 手工上传与 Echo 回执

关闭 Flow 后，打开「Echo 工作区」（`/workspaces`）。选择「单条线索报告」，填写本次需求，分别上传 Finding 和源码包，再执行并查看或下载 `receipt.md`。源码包按原始字节保存，不解压、不运行；Echo 只出具材料回执。再次执行会生成另一条记录。它不需要 Pi、模型凭据或外部服务。

在 Echo 工作区中先准备需求和材料。SOP 独立发布执行器及其配置，执行时可以采用类型推荐的版本，也可以选择其他已发布版本。首次执行冻结需求和材料，每条尝试记录实际所用 SOP；同一包换版重跑后仍能打开原回执。原有派工定义通过【派工模板】进入。见[领域职责与独立验收](WORK-DOMAINS.md)和[工作包接口](server/src/work/workspace_sop/HTTP.md)。

## 检查

```sh
cargo test --locked --workspace
(cd web && npm run check)
```

[浏览器联合验收](web/acceptance/README.md)使用工作台构建的 Server 和 Web。Flow 和本地 Agent 的运行条件见 [Server 使用说明](server/README.md)。
