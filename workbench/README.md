# 工作台开发入口

工作台由 [Server](server/README.md) 和 [Web](web/README.md) 组成。Server 提供 API，Web 在开发时通过 Vite 将同源 `/api` 请求转发给 Server。`workbench/` 是 Cargo 工作区根目录，`web/` 使用自己的 npm 锁文件。请从完整仓库检出构建，Server 编译时依赖仓库内的 [Flow SDK](../flow-runtime/client/README.md)。

**旧实例升级前：先停服，备份整个 `$URSI_DATA_DIR/work/`。** 新版首次打开旧存储时会不可逆地删除派工记录、模板及专属制品和配置快照。旧单不会转换为工作清单项。保留范围和恢复条件见 [Server 使用说明](server/README.md#旧数据升级)。

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

Server 默认监听 `0.0.0.0:8080`，可用 `URSI_LISTEN_ADDR` 改；Web 开发服务与 `vite preview` 同样监听所有网卡，同一网段的手机和电脑可直接用本机地址打开页面。主机名访问需在 `URSI_ALLOWED_HOSTS` 列明。明文 HTTP 会以头部传递令牌，只应在可信网段使用，否则在 Web 前面加 HTTPS 反向代理。

## 工作清单

从 `/work-items` 新建工作项，按类别（一次性工作、持续工作）和状态（待开始、进行中、已完成）筛选。工作项可独立存在，也可多次生成工作包。修改或解除包的当前关联不会改变生成来源，删除工作项后保留包和文件。

接入带凭据的 MCP 服务时，可在「平台设置 → 环境变量」新增或替换凭据，例如 `GITHUB_PAT_TOKEN`。新连接使用最新值，无需重启。变量值保存在私有工作存储中，请保护数据备份。

打开「平台 MCP 服务 → 登记服务」，填入名称和地址，选择已保存的平台变量，点击「添加服务」。点击「浏览资源」进入服务检查页，从「工具目录」选择工具、查看参数、勾选调用许可并确认调用；「工具设置」可修改 GitHub 工具集和只读模式。也可获取提示词或读取资源模板。默认部署无需编辑策略文件。在工作项编辑页勾选具体资源、设置别名并保存 Python 脚本，回到详情点击「生成工作包」。脚本接口为 `transform(item, resources)`。授权示例、隔离依赖和脚本样例见[平台 MCP 接入契约](server/src/work/mcp/PLATFORM.md)。仅使用清单无需配置 MCP 或 Python。

从「工作包生成器」发布 Python 脚本并按版本试运行，或在工作项编辑页绑定一个固定版本。保存不会自动执行。手动发起后可在「生成记录」查看输入摘要、只读试运行文件或关联工作包。详见[工作包生成器设计](../docs/design/workbench/WORK-PATCH-GENERATOR-DESIGN.md)。

## 目录编辑台

从「工作包」进入 `/work-patches`，输入包名后直接整理文件。从「配置包」进入 `/config-patches`，分别编辑 `AGENTS.md`、`skills/` 和 `mcp.json`。工作包的业务记录保存目录引用、来源和可选的工作项归属。也可以不建包，直接 `POST /api/v2/directories` 创建虚拟目录，再用返回的 ID 读写文件。见[目录接口](server/src/work/directories/HTTP.md)和[模块分工与交互对照](../docs/design/workbench/PATCH-STUDIO.md)。

## 资源库与执行器

在 `/resources` 发布资源，在 `/executors` 发布引用指定提示词或技能修订的执行器。两种目录都能打开历史修订。发布执行器只保存定义，不会启动运行。

执行一次任务走独立的 HTTP 入口：调用方生成小写 UUID，向 `PUT /api/v2/executor-attempts/{attemptId}` 提交指令，可附工作包。回执丢失用同一路径 GET 查回；取得终态的 `artifactDirectoryId` 后，通过目录接口读报告。省略执行目标时使用部署固定的 Flow，也可指定 Agent 修订或提交草稿试跑。三种路径的区别见[执行器设计](../docs/design/workbench/EXECUTOR-DESIGN.md)，部署变量、请求示例和取消语义见[执行器接入说明](EXECUTOR-INTEGRATION.md)。

## 检查

```sh
cargo test --locked --workspace
(cd web && npm run check)
```

[资源库与执行器联合验收](web/acceptance/README.md)和[工作清单与包目录联合验收](web/patches-acceptance/README.md)均使用工作台构建的 Server 和 Web。两套验收共用端口，应分别运行。Flow 的运行条件见 [Server 使用说明](server/README.md)。
