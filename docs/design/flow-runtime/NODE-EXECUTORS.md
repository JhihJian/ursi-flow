# 节点级执行器选择

状态：已实现（2026-11-24）。解析器拆后缀、daemon 启动时钉修订、PlatformAgent 按节点取修订、本地 Pi 模式拒绝后缀，均已落地并有测试覆盖。

## 方案

一句话：`新建Agent:名称` 的名称就是平台执行器 id，启动 Run 时由 daemon 解析各名称当时的最新发布修订并钉进 Run。

1. FLOW.md 里 `新建Agent` 标记允许带后缀：

```markdown
## 评审代码

```新建Agent:deepseek-reviewer
请完成代码评审，并提交最终结论。
```
```

2. 启动 Run 时，daemon 对 Flow 闭包内每个执行器名称调用平台的 `GET /v2/executors/{id}`（消费者接口），取得当时的最新发布修订，钉死写入 job.json。
3. 派发节点时按标记的名称查已钉死的修订，用该修订启动尝试。平台本就按尝试接受 `executorRef`，平台侧零改动。

解析器把 `新建Agent:名称` 规范化为 `{kind: "新建Agent", executor: "名称"}`，`AgentActionKind` 不变，既有按 `kind` 判断的执行与预检逻辑不受影响。名称格式与 profile 相同（`[A-Za-z][A-Za-z0-9_-]*`）。标记可与结构化 JSON 组合：标记带执行器，JSON 带 profile/prompt。

## 语义规则

1. 后缀只能出现在 `新建Agent`；`复用Agent` 带后缀是解析期错误，复用继承当前绑定的执行器。
2. 没有后缀的节点用 Run 级 `executorRef`（启动方显式提供的修订），与现状一致。
3. 名称声明的执行器始终解析最新发布修订：执行器发布新修订后，下一次 Run 自动生效，Flow 文件不动。单次 Run 内钉死，重试与恢复都用已钉死的修订。
4. 启动校验：名称在平台不存在、或最新修订未声明 flowOutcome 能力，即拒绝启动。本地 Pi 模式遇到带后缀的 Flow 同样拒绝（混跑后议）。
5. 同 ID 重试复用 job.json 已钉死的修订，不重新解析，避免重试中修订漂移。

## 为什么其余机制不用改

- 取消与状态查询只认 `attemptId`，与用哪个修订无关，停止和恢复代码路径不动。
- unverified 恢复按 `attemptId` 去平台查询，已落盘的事实够用。
- 全部修订走同一个平台端点（进程只有一个 `URSI_EXECUTOR_PLATFORM_URL`），不存在跨平台问题。
- 子 Flow 与父 Run 共用同一批名称，解析一次即可。
- 审计：job.json 记录解析结果 `{名称: {id, revision}}`，哪个节点用了哪个修订可查。
- `run.start` 不加参数，CLI、控制台、工作台零改动。

## 改动点

| 位置 | 改动 |
| --- | --- |
| definition/parser.ts | 拆标记后缀并校验格式 |
| contracts/types.ts | `AgentAction` 加 `executor?` 名称 |
| machine/runs.ts + daemon.ts | 启动时解析名称为最新修订并钉进 job.json |
| executor-adapters/platform.ts | 构造时收已钉死的映射，启动尝试按节点名称取修订 |
| core/execution | 派发请求携带节点对应的执行器修订 |

## 暂缓

- 本地 Pi 与平台的混合执行、本地 Pi 的节点级模型覆盖。
