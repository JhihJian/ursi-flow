---
references:
  - ARCHITECHTURE.md
  - apps/ursi-flow/docs/flow-spec.md
  - apps/flow-web/README.md
  - docs/design/deployment/DEPLOYMENT.md
---

# ursi-flow

## 功能意图

ursi-flow 把可重复的工作过程写成以 `FLOW.md` 为入口的包。[ursi-flow](apps/ursi-flow/SPEC.md) 是这部分能力的交付包：其中的 [Flow Core](apps/ursi-flow/core/SPEC.md) 是无状态推进 SDK，[Flow Executor](apps/ursi-flow/executor/SPEC.md) 定义执行器的两个方法，[Flow Runtime](apps/ursi-flow/runtime/SPEC.md) 的引擎读 FLOW.md、逐步调用执行器、按回执选边并产出最终结果，过程写成日志实体与文件存储。包自带命令行，装上就能执行一个 Flow 包。

[Flow 工作台](apps/flow-web/SPEC.md) 用浏览器浏览 flow home 里的包、启动运行、回答人工确认并查看过程日志。独立的 [SUMM-Todo 看板](apps/todo-web/SPEC.md) 读取本机待办库，用于查看和维护项目与任务。[dae 路由观察台](apps/dae-web/SPEC.md) 读取本机 dae 的代理状态，用于查看连接走向与路由判决。[SSH 终端](apps/ssh-web/SPEC.md) 管理本机 SSH 连接配置，在浏览器中提供远端 PTY 终端，它的连接表同时是[位置契约](packages/location/SPEC.md)里的设备清单。[fs-web 文件管理器](apps/fs-web/SPEC.md) 浏览与编辑本机及远程目录，目录身份统一用位置 URI（`file:///abs`、`ssh://<设备>/abs`）。[Pi Web](apps/pi-web/SPEC.md) 是浏览器里的 pi 工作台：配置、对话与会话浏览共用一个进程与一套领域模型，一份 pi home 决定整套能力，会话只有一个身份，历史、运行中与一次性任务都是同一实体的不同状态。

模块职责、调用关系和设计文档见[架构与设计索引](ARCHITECHTURE.md)。

## 关键功能与验收

### 查看本机待办看板

#### 验收

- 独立构建并启动的看板读取 SUMM-Todo 本机库，按项目展示任务与今日、本周、本月统计，可新建、编辑和删除项目与任务。
- 拖拽任务到状态标签或项目项后，状态或归属写入同一待办库；重新加载页面仍保持结果。

### 管理 Pi home 配置

#### 验收

- 独立构建并启动的管理台监听 `0.0.0.0:8093`，自动探测默认 pi home，切换任意包含 `settings.json` 的目录后分区即时刷新。
- 编辑 settings.json 受管项、skills 开关、subagent profile 与内置开关、MCP 与自定义模型条目、凭据后，重新读取文件确认写入；文件被其他进程修改时写入被拒绝且原文件保留。
- 凭据只以掩码回显，明文不出现在任何接口响应；写操作仅限本机来源，非回环请求返回 403。

### 查看本机代理路由

#### 验收

- 独立启动的 dae 路由观察台监听 `0.0.0.0:8092`，通过同源 `/api` 读取本机 dae 的运行态、连接、流记录、规则、DNS 与日志，浏览器不需要访问 dae 的 loopback 端口。
- 选中一条连接后可回放当前规则，得到最终出口与每条候选规则的判定结果；关闭连接与清缓存只在回环地址访问时可用。
- 配置分区只能从本机访问：按配置源编辑 `config.d/*.dae` 后由 dae 校验并写入，dae 生成备份并热加载。

### 用引擎跑完一份 Flow

#### 验收

- 引擎接收 `FLOW.md` 原文与启动变量，返回 `completed`、`awaiting_input` 或 `failed`，并保留每一步的结果与变量。
- 执行 Agent 只需实现 `prompt(agentName, instruct)`，执行命令只需实现 `command(invocation)`；引擎不读取模型配置、不启动子进程、不接触网络。
- 过程日志按运行写入文件，事件序号单调递增，快照可恢复；`respond` 对等待中的确认步骤提交结果，`resume` 从快照继续。

### 在浏览器里运行 Flow

#### 验收

- 侧边栏列出 flow home（默认 `~/.ursi/flow`）下的 Flow 包，可改成任意本机绝对路径，改完立即重扫。
- 选中包后工作区显示变量表单与结构，变量填好后启动一次运行；出现人工确认时在页面上选一条结果边继续，完成或失败都能看到结果与逐条过程事件。
- 解析失败的包照样列出并标明原因，不阻塞其它包；同一个工作台可以停止未结束的运行、从快照继续、复制运行摘要。
- 作为 `flow` 模块接入工作区外壳后，注册「在文件模块打开 Flow 目录」这条跨模块操作，目标模块未启用时给出禁用原因。

### 拿到 FLOW.md 就能执行

#### 验收

- 安装 `apps/ursi-flow` 的构建产物后，`ursi-flow run <FLOW.md|包目录>` 执行一次运行并打印最终结果，日志落在运行目录下。
- 未接入真实 Agent 时由 `FakeExecutor` 作答，示例 Flow 能跑到完成；遇到确认节点时交互终端里选一条结果边继续，非交互终端报告等待状态。
- 换成真实执行器只替换适配器，`core`、`executor` 契约与 `runtime` 都不需要改。
