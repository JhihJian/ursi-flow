# Web v2 联合验收签收报告

## 结论

真实浏览器双单链路通过：经办人在浏览器发布提示词、本地 Agent 执行器与工作包第 1 版，按同一版本派 A、B 两单；发布第 2 版后两张旧单仍显示第 1 版的 SOP、验收标准与固定执行器资源；两单各执行一次都读到真实 Pi 执行输出，状态仍为办理中；A 通过第 1 版，B 附意见退回后在同一张单提交第 2 版并通过；刷新与深链重开三个交付版本都能对上文件、退回意见与通过版本。移动视口与 JSON 来源专项同时通过，基础回归（lint、类型检查、单测、构建、旧 Flow 与对话桌面与移动回归）全部通过。

结论成立的范围是：**只有模型是模拟的**。执行器、工作包快照、工作数据、交付与验收接口都是真实 `ursi-server` 实现，浏览器也没有任何接口拦截。

## 版本与环境

| 项目 | 值 |
| --- | --- |
| 工作包 | 06 联合验收，分支 `web-v2/06-acceptance`（基线 `main` 的 `1cd6257`，已合并 01 至 05） |
| Web | `@ursi-flow/web@0.1.0`，`npm run build` 产物经 `vite preview` 提供，同源代理 `/api/v1`、`/api/v2` |
| Server | `/data/dev/ursi-flow/target/debug/ursi-server`（dev profile，`cargo build --locked -p ursi-server` 构建） |
| 执行器 | 真实 Pi CLI `pi 1.5.2`（`PATH` 中） |
| 浏览器 | Playwright 1.65.1，Chromium build 1255；移动视口 Pixel 7（412×839） |
| 运行时 | Node v24.13.1，npm 11.8.0，Linux 7.0.0-38-generic |
| 运行日期 | 2026-11-19 |

## 模拟范围

模拟的只有模型：`web/acceptance/fixtures/model-server.ts` 是本机回环的固定回复端点，用临时 Pi 配置（独立 `HOME`、`PI_CODING_AGENT_DIR` 下的 `models.json` 与 `settings.json`）把它配置成 `fixed-local-model`，固定返回 `SIMULATED-MODEL: fixed report`。

不属于模拟的部分：Pi CLI、Server、工作包发布与快照、工作项、执行尝试、交付文件读取（`text/plain`）、验收与退回、来源目录与派工接口都是真实实现。浏览器侧没有任何 `page.route` 或其他请求拦截。

## 复跑命令

全部命令都在 `web/` 下执行。

| 命令 | 覆盖 |
| --- | --- |
| `npm run test:acceptance` | 联合验收三个场景（自动构建产物并启动真实服务） |
| `npx playwright test --config playwright.acceptance.config.ts --project desktop` | 主场景：双单办理与验收 |
| `npx playwright test --config playwright.acceptance.config.ts --project sources` | JSON 来源派工 |
| `npx playwright test --config playwright.acceptance.config.ts --project mobile` | 移动视口 |
| `npm run lint` | ESLint，含新增验收资产 |
| `npx tsc --noEmit` | 应用侧类型检查（`tsconfig` 只含 `src`、`e2e` 与两个配置文件） |
| `npm run test` | Vitest 单测 |
| `npm run build` | 类型检查 + 生产构建 |
| `npx playwright test` | 旧 Flow 与对话回归（桌面 + 移动，接口拦截版） |

复跑要求：本机可以构建 `ursi-server`、`PATH` 中有真实 `pi`、`web/node_modules` 已就绪；默认端口 18100、18101、18102、4180、4181 空闲。

## 主场景逐步观察

签收运行的单号来自本次运行，每次复跑都会新建数据目录、令牌与单号。

### 1 关闭 Flow 与来源后发布定义

登录后侧栏只有「工作清单、工作包、资源库、执行器、对话」：`/api/v2/sources` 与 `/api/v1/flows` 都返回 404，入口按设计收起，工作清单显示空态。

| 步骤 | 观察结果 |
| --- | --- |
| 资源库 → 新建资源 | `guide` v1 发布成功，落在 `/resources/guide/revisions/1`，内容是提示词 `PROMPT-CHECK-THE-EVIDENCE-v1` |
| 执行器 → 新建执行器 | `assistant` v1 发布成功，类型 Agent、环境「本地 Pi Agent」、固定资源 `guide v1` |
| 工作包 → 新建工作包 | `triage` v1 发布成功，SOP `SOP-READ-THE-TICKET-v1`，验收标准「核对报告结论与工单编号一致」，必交 `report.txt`，输入声明 `note: string`，动作 `inspect → assistant v1` |

### 2 用 r1 派两单，发布 r2 后旧单仍是 r1

| 单据 | 单号 | 材料编号 |
| --- | --- | --- |
| A | `40616643-82ff-4b40-9232-cd7fd5d0fafb` | `ticket-A-489a296e` |
| B | `4c47dad2-fa15-42f4-8e89-ca89a21e2a45` | `ticket-B-2c9cbc02` |

两次派工都只在浏览器填材料并点「创建待办理工作项」，落库状态为「待办理」。随后在浏览器把提示词发成 v2（`PROMPT-CHECK-THE-EVIDENCE-v2`）、执行器发成 v2（固定 `guide v2`）、工作包发成 r2（SOP 改为 `SOP-READ-THE-TICKET-v2`，验收标准改为「核对报告结论、工单编号与回执截图说明」，动作绑定 `assistant v2`）。

发布 r2 后重新打开两张旧单：页首都仍是 `triage v1`，本次输入是各自的编号，「开单时的 SOP」仍是 v1，页面没有出现 `SOP-READ-THE-TICKET-v2`、新版验收标准或新提示词；固定动作行仍是 `inspect → assistant v1（本地 Agent） · guide v1`。工作清单两行都显示 `triage v1`。

### 3 两单各执行一次

浏览器里分别「开始办理」（经办人 Lin）→「执行一次」。

| 单据 | 尝试 ID | 尝试状态 | 输出 | 执行后业务状态 |
| --- | --- | --- | --- | --- |
| A | `8ebaf47e-d104-45cf-9b50-6ec2fee86edd` | 执行成功 | `SIMULATED-MODEL: fixed report` | 办理中 |
| B | `fa3b2a5f-2faf-437b-8c25-5cb620501fee` | 执行成功 | `SIMULATED-MODEL: fixed report` | 办理中 |

模型端点只收到 2 次请求，每次一条用户消息（170 字符），摘要如下：

| 请求 | 模型 | 流式 | 用户消息里的编号 | 提示词 | SOP |
| --- | --- | --- | --- | --- | --- |
| 1（A） | `fixed-local-model` | 是 | `ticket-A-489a296e` | `PROMPT-CHECK-THE-EVIDENCE-v1` | `SOP-READ-THE-TICKET-v1` |
| 2（B） | `fixed-local-model` | 是 | `ticket-B-2c9cbc02` | `PROMPT-CHECK-THE-EVIDENCE-v1` | `SOP-READ-THE-TICKET-v1` |

两次请求都不含新版提示词，也不含另一张单的编号，说明执行用的是开单时的快照。

### 4 交付、退回与按版本验收

| 动作 | 结果 |
| --- | --- |
| A 提交第 1 版并勾选本次尝试 | 状态变为待验收，随后「通过」（验收人 Chen），状态变为已交付，交付页签标注「第 1 版（已通过）」 |
| B 提交第 1 版 | 状态待验收；验收意见填「请补充 ticket-B-2c9cbc02 的复核结论与回执编号」并「退回」，状态回到办理中，办理页签显示退回意见 |
| B 在同一张单提交第 2 版 | 交付页签提示「第 1 版被退回 · Chen」并给出来回意见；提交后状态待验收，再「通过」，标注「第 2 版（已通过）」 |

服务端事实与页面一致：A `acceptedVersion=1`、交付版本 `[1]`；B `acceptedVersion=2`、交付版本 `[1,2]`，第 1 版验收记录是「退回 / Chen / 上述意见」，第 2 版是「通过 / Chen」。

深链与刷新核对：

| 地址 | 观察结果 |
| --- | --- |
| `/items/<A>/deliveries/1` | 文件正文是 A 的报告，验收记录「通过 · Chen」，版本导航标注已通过；刷新后内容不变 |
| `/items/<B>/deliveries/1` | 文件正文是 B 的第 1 版初稿，验收记录「退回 · Chen」并显示原退回意见，没有「通过」「退回」按钮 |
| `/items/<B>/deliveries/2` | 文件正文是 B 的第 2 版修订稿，验收记录「通过 · Chen」 |
| `/items/<B>/deliveries/9` | 显示「交付版本不存在。」，不回落到当前版 |

清单状态：`/items?status=delivered` 两行都显示「已交付」，`/items?status=review` 显示「暂无待验收工作项」。

## 移动视口

单号 `99298097-f14e-4c50-a745-7e92b9f2fee3`（包 `mobile-check` v1，材料 `ticket-M-1143e1`）。待审材料用真实 HTTP 接口准备（同一令牌、同一 Server），四个目标动作都在浏览器完成：

| 步骤 | 观察结果 |
| --- | --- |
| 抽屉进清单 | 「打开导航菜单」打开抽屉，先进入工作包目录，再从抽屉回到 `/items`，抽屉随之关闭 |
| 打开待审报告 | 点「待验收」筛选到 `/items?status=review`，行内显示待验收，进入详情默认落在「交付与验收」，读到待审报告正文 |
| 退回 | 填验收人 Chen 与意见「移动端退回：请补充核对依据」后退回，状态回到办理中，办理页签显示退回意见 |
| 重读旧版 | 回到交付页签点「第 1 版（当前）」，地址带上 `?status=review`，文件正文与「退回 · Chen」原意见都在；刷新后仍可读 |

工作清单、待验收详情、旧版交付详情三处均无横向溢出（`scrollWidth <= innerWidth`）。

## 来源专项

另起一台 `URSI_WORK_SOURCES` 指向本机 `0600` JSON 导出的 Server。来源 `tickets` 只开放 `inspect`，而工作包 `source-triage` v1 的快照里同时有 `inspect` 与 `review` 两个动作。

| 步骤 | 观察结果 |
| --- | --- |
| `/sources` | 列出 `tickets`，说明是 `json-file · inspect` |
| 来源条目 | `订单回执缺失`，条目材料里能看到 `未收到回执` |
| 固定动作 | 下拉只有「请选择动作」与 `inspect` 两项，没有 `review`；派工后落到 `/items/e0cd071a-0dac-406a-8b8e-b39fdb1228cf` |
| 办理页签 | 来源 `tickets`、条目 `T-1`、获准动作 `inspect`；固定动作只列 `inspect → source-agent v1（本地 Agent）`，动作下拉只有一个选项且不可切换 |
| 同一清单 | 点「返回工作清单」再筛「办理中」，该行显示 `source-triage`、单号、`tickets · T-1 · inspect`、办理中 |

## 基础回归

| 命令 | 结果 |
| --- | --- |
| `npm run lint` | 通过（0 warning，0 error） |
| `npx tsc --noEmit` | 通过（范围是 `src`、`e2e` 与两个配置文件；`acceptance/` 由 ESLint 与运行验证） |
| `npm run test` | 19 个文件 130 个用例全部通过 |
| `npm run build` | 通过 |
| `npx playwright test` | 20 个用例全部通过（桌面 + 移动，旧 Flow 与对话，接口拦截版） |

`npx playwright test` 属接口拦截回归，只证明页面按约定接口工作，不作为真实服务验收。

## 失败与未测项

- 本工作包内没有遗留的断言失败。过程中修掉的都是验收脚本自身的问题：单号解析把 `/items/new` 当成单号、`动作` 下拉的可访问名称包含选项文案、移动端交付深链会沿用 `?status=review`。这些是脚本问题，不是页面缺陷。
- 未验证：Firefox 与 Safari；真实沙箱（ACP）执行；真实第三方平台在线同步；服务端崩溃后再恢复的浏览器表现；两个标签页同时办理同一张单的竞态（见下节）。这些不在本包范围或缺少环境。

## 已知跨端风险

**交付接口缺少原子版本前置条件（05 交回）。** 提交新版交付时，服务端只校验工作项处于办理中，不校验起草时看到的最后交付版本。双标签页下，旧页在退回后仍能提交按旧意见写的稿子，服务端会接受并生成新版本。本包按交付要求不改服务端与页面实现，只在验收中记录现状：主场景单标签页顺序操作不受影响，风险只出现在并发多标签页。处理建议是由产品与 Server 负责人裁决是否给 `POST /api/v2/items/{id}/deliveries` 增加原子版本前置条件（例如带上起草时的最后交付版本号，冲突返回 409），裁决前保留 `web/src/modules/work-detail/SPEC.md` 已记录的边界说明。本报告不把该风险算作主场景失败。

## 交回模块负责人的缺陷

本次验收未发现阻断主场景的页面缺陷，也没有需要 01 至 05 修改的问题。两处可继续打磨的体验点（不阻断交付，不由本包修改）：

- `web/src/modules/work-detail/Handling.tsx` 的动作下拉用可见文案包裹 `select`，可访问名称会带上选项文本，自动化与读屏者更依赖 `aria-label`。建议由 05 补 `aria-label="动作"`。
- 来源条目详情的动作下拉已有 `aria-label`，与上一处风格不一致，可随 04 一并统一。
