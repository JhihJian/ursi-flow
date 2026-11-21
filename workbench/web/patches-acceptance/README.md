# 工作包与配置包联合验收

使用真实 Web 构建产物和 Rust Server，在桌面及移动浏览器验证工作清单、工作包生成器、MCP 配方与两类包的文件编辑。验收关闭 Flow，不启动 Pi 或模型服务。

- 工作清单：只填标题创建默认的一次性、待开始工作项，分别修改类别和状态并核对保存结果。连接测试用 MCP 服务生成文件包后，两项属性保持不变；删除工作项后，文件及生成记录仍可读取。
- 工作包生成器：从主导航进入生成器，选择已登记的 MCP 资源试运行。发布新版后，从生成记录重读旧版试运行的只读文件，并由工作项生成仍绑定旧版的关联包。同一运行 ID 重试只发布一个包，从工作项和包来源都能回到对应记录。删除工作项后，包和记录仍可双向打开。服务端失败用例核对 MCP 读取失败、产物非法和发布前工作项修订冲突都不会发布目录或包。
- 工作包：创建空包，建目录和文件，保存后重读，并通过目录接口核对原文。
- 配置包：核对默认目录结构，保存提示词，确认无效的 MCP JSON 不会保存，创建 Skill 并核对文件。

## 复跑

在 `workbench/` 下依次执行：

```sh
cargo build --locked -p ursi-server
cd web
npm run test:patches-acceptance
```

需要 Node.js 24、Web 依赖和 Playwright Chromium。生成用例另外需要[服务端转换契约](../../server/src/work/worklist/CONVERSION.md)列出的 Linux 用户命名空间、bwrap、系统 Python 和 libseccomp。试运行和绑定生成均使用真实隔离环境。

可追加 `-- --project desktop` 或 `-- --project mobile` 单独运行一种视口，或追加 `-- work-patch-generators.spec.ts` 只运行生成器用例。

夹具在 `patches-acceptance/.run/` 创建隔离的数据目录与临时令牌，默认使用本机端口 `18200` 和 `4280`。端口可通过 `URSI_PATCHES_ACCEPTANCE_API_PORT` 和 `URSI_PATCHES_ACCEPTANCE_WEB_PORT` 修改。`URSI_PATCHES_ACCEPTANCE_SERVER` 可指定已构建的服务端，`URSI_PATCHES_SKIP_BUILD=1` 可复用现有 Web 构建产物。

结束后停止本次进程并清理临时业务数据。截图保存在 `patches-acceptance/evidence/patches/`。
