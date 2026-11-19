# 回执工作区联合验收

用真实浏览器、真实 Web 构建产物和真实 Rust Server 验收回执工作区。
执行器是服务端内置的 `echo`，**不启动 Pi、模型、来源或任何守护进程**，浏览器请求也不做拦截。

## 覆盖范围

桌面（Chromium）与窄屏（Pixel 7）各跑一遍同一业务链路：

1. 从旧 `/items` 工作清单进入 `/workspaces`。
2. 新建两张需求不同的工作单，上传**同名不同内容**的材料（`Finding` 与 `源码包`）。
3. 冻结前修改需求；执行后页面与服务端都禁止再改需求和材料。
4. 预览回执与页面下载的 `receipt.md` 逐字节相同；服务端 `?download=true` 返回同一正文和附件头。
5. 甲单重跑，两次尝试都成功，第二次回执可读。
6. 两张单的同名材料摘要不同，回执正文不串单。
7. 同目录重启真实 Server 后，工作单、材料、尝试和同一尝试的回执仍可查。

辅助 HTTP 校验只用来读取服务端事实（类型、详情、回执正文和附件头、材料落盘路径），主路径全部由浏览器完成。

## 前置条件

在 `workbench/` 构建 Server：

```sh
cargo build --locked -p ursi-server
```

`web/node_modules` 必须已存在。脚本不会安装依赖，也不会修改 `package.json` 或锁文件。

## 复跑

在 `workbench/web/` 执行：

```sh
npx playwright test --config echo-acceptance/playwright.config.ts
```

只跑桌面或窄屏：

```sh
npx playwright test --config echo-acceptance/playwright.config.ts --project desktop
npx playwright test --config echo-acceptance/playwright.config.ts --project mobile
```

默认会执行 `npm run build` 生成最新 Web 产物。已经构建过时可跳过：

```sh
URSI_ECHO_SKIP_BUILD=1 npx playwright test --config echo-acceptance/playwright.config.ts
```

## 隔离环境

`global-setup.ts` 每次运行都会：

1. 重建 `echo-acceptance/.run/`，创建私有数据目录、工作区、HOME、日志和进程清单，并清理上次遗留进程。
2. 生成新的 32 字节 Bearer 令牌，只写入 `.run/runtime.json`。
3. 以白名单环境启动 Server：`URSI_FLOW_ENABLED=0`，不设置 Pi、模型、来源和沙箱变量。
4. 启动 `vite preview`，`/api/v1` 与 `/api/v2` 同源代理到本次启动的 Server。

`global-teardown.ts` 停止本次进程并删除临时数据、工作区和 HOME，保留 `.run/logs` 供排查。

可覆盖的环境变量：

| 变量 | 默认 | 用途 |
| --- | --- | --- |
| `URSI_ECHO_ACCEPTANCE_API_PORT` | `18200` | Server 端口 |
| `URSI_ECHO_ACCEPTANCE_WEB_PORT` | `4280` | Web 预览端口 |
| `URSI_ECHO_ACCEPTANCE_SERVER` | `workbench/target/debug/ursi-server` | Server 二进制 |
| `URSI_ECHO_SKIP_BUILD` | 未设置 | 置 `1` 时复用现有 `dist/` |

端口被占用时启动直接失败并指出占用项，不复用其他实例。

## 证据

- `echo-acceptance/evidence/workspace-desktop.json`、`workspace-mobile.json`：工作单、尝试、材料大小、回执摘要、下载是否等于预览、重启后是否仍可查、页面 JS 错误。
- `echo-acceptance/evidence/playwright-report.json`：Playwright 报告。
- `.run/artifacts/`：失败时的截图、追踪和视频。

证据只含回执摘要，不含令牌和完整私有材料。
