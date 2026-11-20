# 工作包与配置包联合验收

使用真实 Web 构建产物和 Rust Server，在桌面及移动浏览器验证工作清单、MCP 配方与两类包的文件编辑。验收关闭 Flow，不启动 Pi 或模型服务。

- 工作清单：只填标题创建默认的一次性、待开始工作项，分别修改类别和状态并核对保存结果。连接测试用 MCP 服务生成文件包后，两项属性保持不变；删除工作项后，文件及生成记录仍可读取。
- 工作包：创建空包，建目录和文件，保存后重读，并通过目录接口核对原文。
- 配置包：核对默认目录结构，保存提示词，确认无效的 MCP JSON 不会保存，创建 Skill 并核对文件。

## 复跑

在 `workbench/` 下依次执行：

```sh
cargo build --locked -p ursi-server
cd web
npm run test:patches-acceptance
```

需要 Node.js 24、Web 依赖和 Playwright Chromium。可追加 `-- --project desktop` 或 `-- --project mobile` 单独运行一种视口。

夹具在 `patches-acceptance/.run/` 创建隔离的数据目录与临时令牌，默认使用本机端口 `18200` 和 `4280`。端口可通过 `URSI_PATCHES_ACCEPTANCE_API_PORT` 和 `URSI_PATCHES_ACCEPTANCE_WEB_PORT` 修改。`URSI_PATCHES_ACCEPTANCE_SERVER` 可指定已构建的服务端，`URSI_PATCHES_SKIP_BUILD=1` 可复用现有 Web 构建产物。

结束后停止本次进程并清理临时业务数据。截图保存在 `patches-acceptance/evidence/patches/`。
