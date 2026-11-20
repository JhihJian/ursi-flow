# 资源库与执行器联合验收

桌面和移动浏览器通过真实 Web 和 Rust Server 发布两个版本的提示词与执行器，再从旧执行器的深链核对固定资源版本与正文。

在 `workbench/` 构建服务端，然后从 `web/` 运行验收。需要 Node.js 24、Web 依赖和 Playwright Chromium。

```sh
cargo build --locked -p ursi-server
cd web
npm run test:acceptance
```

报告在 `acceptance/evidence/playwright-report.json`，失败截图和追踪在 `acceptance/.run/artifacts/`。两套联合验收共用[工作包验收夹具](../patches-acceptance/README.md)的运行目录和回环端口，应分别运行。用 `npm run test:patches-acceptance` 验证工作清单、MCP 配方、工作包和配置包。
