# 节点级执行器选择

## 目标

一条 Flow 内，不同 Agent 节点可以选用不同的执行器修订。典型场景：评审节点用强模型执行器，汇总节点用快而便宜的执行器。执行器引用的具体形态是 executor-platform 的 `{id, revision}` 冻结修订。

## 设计原则

FLOW.md 只声明执行器"名称"，启动 Run 时由调用方提供"名称 → 执行器修订"映射。理由：

1. executorRef 是部署环境事实（哪个平台的哪个修订），写进 Flow 会让流程文件绑死某个平台的修订号，换环境即失效，升级修订就要改所有 Flow。
2. 项目既有惯例是间接层：capabilities 与 profile 都是宿主解释的名称，Flow 不携带实现。
3. 映射在启动时钉死并写入 Run 事实，重试与恢复都有唯一事实源，审计上"哪个节点用了哪个修订"可查。

被否决的形态：

- Flow 内写死 `{id, revision}`：破坏可移植性，修订升级改动已评审的 Flow。
- 按节点名外部映射（不改 Flow）：调用方耦合内部节点名，Flow 改名映射即断，选择意图在 Flow 里不可见。
- 用 Profile 表达执行器差异：Profile 的契约是装配身份（tools/skills），参与连续性校验，兼作执行器路由会让同一字段在两条路径上含义分叉。
- JSON `executor` 字段表达执行器名称：与标记后缀是同一件事的两种写法，保留一种（标记后缀）即可。
- 角色/标签/能力约束匹配引擎：当前需求是“这个节点用那个执行器”，不是跨环境自动匹配。

## 格式设计

`新建Agent` 动作标记允许用半角冒号补充执行器名称：

`````markdown
## 评审代码

```新建Agent:deepseek-reviewer
请完成代码评审，并提交最终结论。
```

### 通过

评审意见齐全。
`````

名称格式与 `profile` 相同（字母开头的 `[A-Za-z][A-Za-z0-9_-]*` 标识）。解析器把标记规范化为 `{kind: "新建Agent", executor: "deepseek-reviewer"}`，`AgentActionKind` 类型不变，既有按 `kind` 判断的执行与预检逻辑不受影响。

`新建Agent:名称` 标记可与结构化 JSON 组合：标记携带执行器选择，JSON 携带 `profile`/`params`/`prompt`，两者正交。

规则：

1. 名称后缀只能出现在 `新建Agent`。`复用Agent` 带后缀即解析期语法错误，复用永远继承当前绑定的执行器归属。名称缺失、含第二个冒号或字符不符合标识格式同样是解析期错误。
2. 不提供 JSON 形式的 `executor` 字段：同一件事两种写法违背格式最小化，标记后缀已覆盖全部场景且在 Flow 文件里更显眼。
3. 未声明执行器的节点使用 Run 级执行器（现有全局 `executorRef` 或本地 Pi）。
4. 执行器选择在解析期静态确定，不依赖变量、不做运行时动态路由。
5. 执行器替换绑定语义：新建(X) → 复用(X) → 新建(Y) 是合法序列，Y 接管绑定，旧会话仍由 X 的平台持有。用 X 的会话在 Y 里继续（跨执行器连续性）不支持。

## 启动与校验

`run.start` / `run.startPinned` 新增可选参数 `executors`（名称 → 执行器修订映射）。启动时 fail-fast 校验：

1. Flow 闭包（含子 Flow）的 `新建Agent:名称` 声明的每个名称必须有映射项，缺失即拒绝启动。
2. 映射中出现 Flow 未声明的名称同样拒绝，防止拼写错误静默回落默认执行器。
3. 对映射中每个不同的 ref 调用平台的 `checkNodeExecutor` 确认修订存在，校验发生在启动时而非节点执行时。
4. v1 范围：仅平台模式（Run 带 `executorRef`）接受 `executors`。本地 Pi 模式下 Flow 声明了任何执行器名称即拒绝启动，提示改用平台模式。

`executors` 纳入 `sameRequest` 重试冲突比较（同 ID 重试要求 Flow、目录、变量、映射一致），并写入 `job.json`。

## 执行与调度

1. `AgentNodeExecutionRequest` 增加可选 `executorRef`。Runtime 在派发节点时按节点声明查映射解析后传入，Core 不接触平台细节。
2. `PlatformAgent` 构造时接受映射，`executeNode` 按请求中的 ref 选择，未声明用构造时的默认 ref。每次 `PUT executor-attempts` 的 `executorRef` 按节点取值。
3. `allocateAttemptId` 语义不变：每个新建节点执行都先分配 ID 并落盘，再派发。
4. worker fork 时经 IPC 接收映射（平台 token 本就经 IPC 传递，无新增密钥通路）。
5. 子 Run 共享父 worker 的执行器集合，映射对子 Flow 同样生效（闭包校验已覆盖）。

## 停止、恢复与审计

1. `NodeRunRecord` 增加可选 `executorRef`，派发前落盘。unverified 恢复按记录中的 ref 去 inspect，不依赖启动时的映射，映射漂移不影响恢复。
2. 停止按各 running 节点记录的 ref 逐个取消，不再假设全 Run 单一执行器。
3. Run 终态分类（unknown 判定）按"当前节点的执行器"决定，本地节点崩溃不被误标为平台待核实。
4. v1 约束：所有映射 ref 必须指向同一平台实例（复用现有 `platformOrigin` 单值校验），多平台不在本方案内。

## 各入口改动

| 入口 | 改动 |
| --- | --- |
| CLI | `run` 命令透传 `executors` 参数 |
| 独立控制台 | 启动对话框提供 JSON 高级输入（同启动变量的处理方式），下拉编辑器后置 |
| Workbench | Server 透传参数，Web 后置 |
| MCP 集成 | 透传参数 |
| executor-platform | 零改动，平台本就按尝试接受 `executorRef` |

## 推迟项

- 同一 Run 混合平台执行器与本地 Pi 节点：涉及 worker 双配置与停止/恢复语义重设计，单独立项。
- 本地 Pi 模式的节点级模型覆盖：provider 是 Run 级配置，需求可先经平台修订满足。
- PlatformAgent 会话连续性：这是独立缺口（`AgentContinuityExtension` 契约已预留），与本方案正交。
- 映射编辑 UI 精修、子 Run 映射差异化继承。

## 需求前提

本方案适用于真实需求是"不同节点需要不同模型/能力"的场景。若场景实际是"平台执行器需要会话连续性"，正确解法是为 PlatformAgent 实现 continuity 扩展，成本远低于本方案。动手前先确认场景归属。
