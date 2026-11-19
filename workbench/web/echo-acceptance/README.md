# 回执工作区联合验收

用真实浏览器、真实 Web 构建产物和真实 Rust Server 验收回执工作区。
执行器是服务端内置的 `echo`，**不启动 Pi、模型、来源或任何守护进程**，浏览器请求也不做拦截。

## 覆盖范围

桌面（Chromium）与窄屏（Pixel 7）各跑一遍同一业务链路：

1. 从旧 `/packages/new` 入口进入新建工作包，真实组件地址是 `/workspaces/new`；表单只有类型和需求，没有 SOP 输入或选择。
2. 新建工作包、修订需求并上传**同名不同内容**的材料（`Finding` 与 `源码包`）。服务端详情没有顶层 `sop`，`ready` 与 `frozen` 分别表示材料齐备和已执行冻结。
3. 第一次执行使用内置默认 `receipt@1`，回执标题为「材料接收回执」。
4. 在 `/sops/new` 用真实表单独立发布同名 SOP 新修订，并指定回执标题；发布前后工作包本身不变。
5. 回到同一包的结果页选择新修订再执行；新尝试保存新 `sop`，回执标题随之改变，旧尝试的 `sop` 与旧回执逐字节不变。
6. 预览回执与页面下载的 `receipt.md` 逐字节相同；服务端 `?download=true` 返回同一正文和附件头。
7. 乙单上传同名材料，两张单的材料摘要不同，回执正文不串单。
8. 同目录重启真实 Server 后，工作包、材料、各次尝试的 SOP 绑定、已发布 SOP 和旧回执仍可查。
9. 窄屏下新建、准备、结果与 SOP 页面都不出现横向溢出。

辅助 HTTP 校验只用来读取服务端事实（类型、详情、SOP 修订、回执正文和附件头、材料落盘路径），主路径全部由浏览器完成。

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

- `echo-acceptance/evidence/workspace-desktop.json`、`workspace-mobile.json`：工作包、`ready`/`frozen`、材料大小、各次尝试的 SOP 版本、回执标题与摘要、旧回执是否不变、下载是否等于预览、发布 SOP 是否触碰工作包、重启后是否仍可查、页面 JS 错误。
- `echo-acceptance/evidence/playwright-report.json`：Playwright 报告。
- `.run/artifacts/`：失败时的截图、追踪和视频。

证据只含回执摘要，不含令牌和完整私有材料。
