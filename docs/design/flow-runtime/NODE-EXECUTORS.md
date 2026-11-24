# 节点级执行器选择

## 方案

一句话：节点在动作标记上声明执行器名称，启动 Run 时把名称映射到平台执行器修订。

1. FLOW.md 里 `新建Agent` 标记允许带后缀：

```markdown
## 评审代码

```新建Agent:deepseek-reviewer
请完成代码评审，并提交最终结论。
```
```

2. `run.start` 增加可选参数 `executors`，即名称到执行器修订的映射：`{"deepseek-reviewer": {"id": "x", "revision": 3}}`。
3. 派发节点时按标记查映射，用对应修订启动尝试。平台本就按尝试接受 `executorRef`，平台侧零改动。

解析器把 `新建Agent:名称` 规范化为 `{kind: "新建Agent", executor: "名称"}`，`AgentActionKind` 不变，既有按 `kind` 判断的执行与预检逻辑不受影响。名称格式与 profile 相同（`[A-Za-z][A-Za-z0-9_-]*`）。标记可与结构化 JSON 组合：标记带执行器，JSON 带 profile/prompt。

## 语义规则

1. 后缀只能出现在 `新建Agent`；`复用Agent` 带后缀是解析期错误，复用继承当前绑定的执行器。
2. 没有后缀的节点用 Run 级 `executorRef`，与现状一致。
3. 启动时校验一条：Flow 声明的每个名称都有映射、映射的修订在平台存在，缺一即拒绝。
4. 本地 Pi 模式遇到带后缀的 Flow 拒绝启动，提示改用平台模式（混跑后议）。
5. 同 ID 重试要求 `executors` 与上次一致，纳入现有 `sameRequest` 比较。

## 为什么其余机制不用改

- 取消与状态查询只认 `attemptId`，与用哪个修订无关，停止和恢复代码路径不动。
- unverified 恢复按 `attemptId` 去平台查询，已落盘的事实够用。
- `executors` 写入 job.json，恢复时 worker 用它重建适配器。
- 全部修订走同一个平台端点（进程只有一个 `URSI_EXECUTOR_PLATFORM_URL`），不存在跨平台问题。
- 子 Flow 与父 Run 共用同一份映射。

## 改动点

| 位置 | 改动 |
| --- | --- |
| definition/parser.ts | 拆标记后缀并校验格式 |
| contracts/types.ts | `AgentAction` 加 `executor?` 名称 |
| executor-adapters/platform.ts | 构造时收映射，启动尝试按节点取 ref |
| machine/runs.ts + daemon.ts | `executors` 参数透传、启动校验、sameRequest |
| CLI / 控制台 / 工作台 | 透传参数 |

## 暂缓

- 本地 Pi 与平台的混合执行、映射编辑 UI。
