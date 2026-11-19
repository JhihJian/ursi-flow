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

## 手工上传与 Echo 回执

关闭 Flow 后，从「工作清单」打开工作包入口（也可直接访问 `/workspaces`）。选择「单条线索报告」，填写本次需求，分别上传 Finding 和源码包，再执行并查看或下载 `receipt.md`。源码包按原始字节保存，不解压、不运行；Echo 只出具材料回执。再次执行会生成另一条记录。它不需要 Pi、模型凭据或外部服务。

类型决定材料角色，版本化 SOP 决定执行器和回执配置。工作包在创建时绑定 SOP，首次执行时冻结材料和需求。HTTP 示例见[工作包接口](server/src/work/workspace_sop/HTTP.md)。

## 检查

```sh
cargo test --locked --workspace
(cd web && npm run check)
```

[浏览器联合验收](web/acceptance/README.md)使用工作台构建的 Server 和 Web。Flow 和本地 Agent 的运行条件见 [Server 使用说明](server/README.md)。
