# 工作台项目与整体交付设计

状态：提案。首版面向 Linux，保留当前 Git 仓库。`workbench/` 是工作台的开发入口和发布单位：维护者在这里构建和测试，部署者按一个版本安装 Server 和 Web，操作者通过一个地址办理工作。

## 项目边界

| 拟定路径 | 职责 |
| --- | --- |
| `workbench/server/` | 原 `server/`。保留 `ursi-server` 包名、HTTP API、鉴权、存储及 daemon 生命周期。 |
| `workbench/web/` | 原 `web/`。保留前端构建、npm 锁文件、页面路由和浏览器业务验收。 |
| `workbench/Cargo.toml`、`Cargo.lock` | 从仓库根迁入。现有 Rust 工作区只有 Server 一个成员，项目根可直接运行 Cargo。 |
| `workbench/Makefile` | 统一入口：`make dev` 启动联调，`make check` 运行组件检查，`make package` 组装发布包，`make acceptance` 验收指定包。 |
| `workbench/deploy/` | 保存生产入口的静态服务与代理配置、启动脚本、环境配置样例。 |
| `workbench/README.md`、`SPEC.md` | 说明开发、安装、运行条件和整体验收。组件内部契约继续归各自规格。 |

`flow-runtime/` 和 `ursi-sandbox/` 保留为仓库根目录的独立项目。首版从完整仓库检出构建：Server 对 Rust SDK 的路径调整为 `../../flow-runtime/client`，即使关闭 Flow 也需要它参与编译。安装发布包则不依赖仓库。将来如需单独检出 `workbench/` 也能构建，应先把 SDK 改为可独立获取的固定版本依赖。

## 发布与运行

每个目标架构交付一个 `ursi-workbench-<版本>-linux-<架构>.tar.gz`。构建使用同一 Git 修订的 Server、Web 和配套 Flow Runtime。包中包含 `bin/ursi-server`、`public/`（Web 的 `dist/` 内容）、已构建的 `ursi-flowd` 及其生产依赖、生产代理配置、启动入口、配置样例与版本清单。CI 以包的版本和 Git 修订标识这套产物，部署时整包替换。

首版采用 Caddy 提供工作台地址。`/api` 及其子路径原样转发给 `ursi-server`，保留其 401、404 和业务错误；静态资源从 `public/` 读取，资源缺失返回 404；前端页面深链才回退到 `index.html`。开发时继续使用 Vite 代理。把静态资源嵌入 Rust 会改变 Server 的非 API 路径返回 404 这一既有契约，统一交付本身无需这项变更。

| 运行条件 | 安装者需要准备什么 |
| --- | --- |
| 工作清单与包目录 | 提供 Caddy、`URSI_API_TOKEN`、私有持久数据目录和受信工作目录。设置 `URSI_FLOW_ENABLED=0` 可只启用 v2，无需 Node。 |
| Flow（保持默认启用） | 目标机提供兼容 Node（首版建议统一验证 Node 24）。启动入口将 `URSI_FLOWD_BIN` 指向随包 daemon，仍由 Server 管理其启停。 |
| 从 MCP 资源生成工作包 | 按[平台 MCP 接入契约](server/src/work/mcp/PLATFORM.md)配置出站授权及 Python 隔离环境。 |

部署者配置后执行包内 `bin/start`。启动入口检查所选功能的前置条件，启动 Server 和 Caddy，任一进程启动失败时退出并清理已启动进程。对外只暴露同源入口。`URSI_DATA_DIR` 和 `URSI_WORKSPACE_DIR` 显式指向包外独立目录，令牌只经运行环境注入。升级时停止旧实例，备份数据，再让新版使用同一数据目录；发布脚本只替换程序和页面。

## 迁移与签收

1. 同批迁移两个组件和根 Cargo 工作区。更新 SDK 路径、规格父子关系、文档链接、CI 隔离检查及浏览器验收的 Server 定位。先验证原有组件测试继续通过。
2. 加入统一命令和打包步骤。发布包使用文件白名单，排除源码、开发机数据、令牌和模型凭据。组件测试可使用本地构建，发布验收必须显式指定候选包。
3. 在没有源码和开发机 `target/` 的干净目录解包，经生产入口验证页面深链可刷新、未认证 API 返回 401、缺失资源不会返回首页。关闭 Flow，新建工作项和关联的工作包，写入文件；重启后按清单项找到该包并读回文件。
4. 默认配置再跑一条固定修订的 Flow，经同一 daemon 的 CLI 核对运行历史，停止工作台后核对 daemon 已退出。两种配置均通过才发布该版本。
