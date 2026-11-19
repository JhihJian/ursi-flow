# Web v2 联合验收

用真实 Web（`npm run build` 产物 + 同源代理）、真实 `ursi-server`、真实 Pi CLI 跑浏览器业务链路。
**模拟的只有模型**：本机固定回复端点返回 `SIMULATED-MODEL: fixed report`。执行器、工作包快照、工作数据、交付与验收接口都是真实服务端实现。

## 复跑

在 `web/` 下一行跑完三个场景（会自动构建产物）：

```sh
npm run test:acceptance
```

单独跑一个场景：

```sh
npx playwright test --config playwright.acceptance.config.ts --project desktop
npx playwright test --config playwright.acceptance.config.ts --project sources
npx playwright test --config playwright.acceptance.config.ts --project mobile
```

## 场景

| 项目 | 用例 | 要证明的事 |
| --- | --- | --- |
| `desktop` | `tests/main.spec.ts` | 浏览器发布提示词、引用它的本地 Agent 执行器与工作包 r1；用 r1 派 A、B 两单；发布 r2 后旧单仍显示 r1；两单各执行一次并读到模型输出且状态仍为办理中；A 通过 v1，B 退回后原单提交 v2 并通过；刷新与深链核对文件、退回意见、通过版本与清单状态 |
| `sources` | `tests/sources.spec.ts` | 另起配置 `json-file` 来源的 Server：来源列表派工进入同一清单，动作下拉只含获准动作 |
| `mobile` | `tests/mobile.spec.ts` | 移动视口从抽屉进清单、打开待审报告、退回、重读旧版 |

## 环境

`global-setup.ts` 每次运行都会：

1. 重建 `acceptance/.run/`，在其中创建业务数据目录、工作区、Pi 配置、私有来源导出与日志。
2. 生成新的 32 字节令牌（只写进 `.run/runtime.json`，不进证据）。
3. 构建 Web 产物（`URSI_ACCEPTANCE_SKIP_BUILD=1` 可跳过）。
4. 启动本机固定模型端点、两台 `URSI_FLOW_ENABLED=0` 的 Server（主场景不配置来源，来源场景用 `URSI_WORK_SOURCES` 指向 `0600` 私有 JSON），以及两台带 `URSI_API_PROXY` 同源代理的 `vite preview`。
5. 子进程环境采用白名单，不继承操作者的模型凭据。

`global-teardown.ts` 停止本次记录的进程组，并删除临时数据目录、工作区、Pi 配置与私有来源文件；`.run/logs` 保留供排查，下一次运行整体重建。

可覆盖的环境变量：

| 变量 | 默认 | 用途 |
| --- | --- | --- |
| `URSI_ACCEPTANCE_MAIN_API_PORT` | 18100 | 主场景 Server |
| `URSI_ACCEPTANCE_SOURCES_API_PORT` | 18101 | 来源专用 Server |
| `URSI_ACCEPTANCE_MODEL_PORT` | 18102 | 模拟模型端点 |
| `URSI_ACCEPTANCE_MAIN_WEB_PORT` | 4180 | 主场景预览服务 |
| `URSI_ACCEPTANCE_SOURCES_WEB_PORT` | 4181 | 来源专用预览服务 |
| `URSI_ACCEPTANCE_SERVER` | `/data/dev/ursi-flow/target/debug/ursi-server` | Server 产物 |
| `URSI_ACCEPTANCE_PI` | `PATH` 中的 `pi` | 真实 Pi CLI |
| `URSI_ACCEPTANCE_SKIP_BUILD` | 未设置 | 置 `1` 时复用现有 `dist/` |

端口默认固定，被占用时启动直接失败并指出占用项，不复用其他实例。

## 证据

`acceptance/evidence/`（已忽略提交）保存每次运行的断言证据：`main-scenario.json`、`sources-scenario.json`、`mobile-scenario.json`，以及 Playwright 的 JSON 报告。内容包括单号、尝试 ID、交付版本、验收结论、模型端点请求次数与用户消息摘要，不含令牌。

## 限制

- 只在 Chromium 桌面内核与 Pixel 7 视口跑，未覆盖 Firefox 与 Safari。
- 依赖本机真实 Pi CLI 与预构建的 `ursi-server`，不属于常规单测。
- 固定端口意味着同一台机器同时只能跑一套验收实例。
- `tsconfig.json` 的 `include` 不含 `acceptance/`，这些文件只受 ESLint 约束，没有独立的全量类型检查；改动验收资产后请至少跑一次 `npm run lint` 与整套验收。
