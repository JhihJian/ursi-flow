// 演示数据：只在静态交付或未配置 Runtime 时使用，不连接 daemon，也不执行命令。
import { ApiError, type FlowConfig, type FlowFiles, type FlowPackage, type Run, type RunHistory, type Source } from './data'

const ordinary: FlowFiles = {
  'FLOW.md': `---
name: 普通流转
description: 用于验证两个串行 Agent 节点。
variables:
  任务:
    description: 本次分析任务
    default: test
---

\`\`\`mermaid
flowchart TD
  start((开始)) --> analyze[分析任务]
  analyze -->|已分析| finishNode[完成任务]
  finishNode -->|已完成| finish((结束))
\`\`\`

## 分析任务

\`\`\`新建Agent
分析任务：
{var.任务}
\`\`\`

### 已分析

| 变量 | 含义 |
| --- | --- |
| 分析结论 | 下一节点完成任务所需的结论 |

已得到下一步所需结论。

## 完成任务

\`\`\`复用Agent
根据分析结果完成任务：
{input.分析结论}
\`\`\`

### 已完成

任务已结束。
`,
}

const releaseCheck: FlowFiles = {
  'FLOW.md': `---
name: 发布检查
description: 校验版本号与发布清单后完成发布。
---

\`\`\`mermaid
flowchart TD
  start((开始)) --> verify[校验发布清单]
  verify -->|已执行| report[汇总检查结果]
  report -->|已执行| finish((结束))
\`\`\`

## 校验发布清单

\`\`\`执行自定义命令
{
  "command": "node",
  "args": ["scripts/verify-version.mjs"],
  "stdout": "variables"
}
\`\`\`

### 已执行

已按 [检查清单](references/checklist.md) 校验版本号。

## 汇总检查结果

\`\`\`执行自定义命令
{
  "command": "node",
  "args": ["-e", "console.log('检查通过')"]
}
\`\`\`

### 已执行

已写入汇总变量，发布检查结束。
`,
  'references/checklist.md': `# 发布检查清单

- 版本号与 CHANGELOG 一致。
- 发布说明包含变更范围。
- 安装包可独立构建。
`,
  'scripts/verify-version.mjs': `const pkg = await import('node:fs/promises').then((fs) =>
  fs.readFile(new URL('../../../package.json', import.meta.url), 'utf8'),
)
console.log(JSON.stringify({ variables: { 版本: JSON.parse(pkg).version } }))
`,
}

const packages: Record<string, FlowPackage> = {
  ordinary: { id: 'ordinary', revision: 'c7b2178f-3d0e-4b5a-9c11-7a2f6d84e001', files: ordinary },
  'release-check': { id: 'release-check', revision: 'c7b2178f-3d0e-4b5a-9c11-7a2f6d84e002', files: releaseCheck },
}

const base = {
  cwd: '/srv/projects/ursi-flow',
  revision: 'c7b2178f-3d0e-4b5a-9c11-7a2f6d84e002',
}
const config: FlowConfig = {
  executor: 'local-pi',
  provider: {
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    api: 'openai-completions',
    apiKeySet: true,
  },
  maxConcurrent: 4,
}

const runs: Run[] = [
  {
    ...base,
    id: 'release-002',
    flow: 'release-check',
    status: 'running',
    variables: {},
    config,
  },
  {
    ...base,
    id: 'review-001',
    flow: 'ordinary',
    status: 'completed',
    variables: { 任务: '评审首页改动' },
    config,
  },
  {
    ...base,
    id: 'verify-003',
    flow: 'release-check',
    status: 'failed',
    variables: {},
    config,
    error: '命令退出码 1',
  },
  {
    ...base,
    id: 'verify-004',
    flow: 'release-check',
    status: 'stopped',
    variables: {},
    config,
  },
]

const at = (minute: number) =>
  new Date(Date.UTC(2025, 0, 8, 9, minute, 0)).toISOString()
const common = { runId: 'review-001' }
const nodeRuns = [
  {
    ...common,
    id: 'nr-review-1',
    sequence: 3,
    nodeName: '分析任务',
    nodeRef: 'analyze',
    actionKind: '新建Agent',
    status: 'completed',
    startedAt: at(1),
    completedAt: at(2),
    input: { 任务: '评审首页改动' },
    outcome: { result: '已分析', variables: { 分析结论: '需要补充错误态说明' } },
    enteredFrom: { kind: 'start' },
  },
  {
    ...common,
    id: 'nr-review-2',
    sequence: 6,
    nodeName: '完成任务',
    nodeRef: 'finishNode',
    actionKind: '复用Agent',
    status: 'completed',
    startedAt: at(2),
    completedAt: at(4),
    input: { 分析结论: '需要补充错误态说明' },
    outcome: { result: '已完成' },
    enteredFrom: { kind: 'route', routeDecisionId: 'rd-1', sourceNodeRunId: 'nr-review-1' },
  },
]

const routeDecisions = [
  {
    id: 'rd-1',
    runId: 'review-001',
    sequence: 4,
    sourceNodeRunId: 'nr-review-1',
    result: '已分析',
    destination: { kind: 'node', ref: 'finishNode' },
    selectedAt: at(2),
  },
  {
    id: 'rd-2',
    runId: 'review-001',
    sequence: 7,
    sourceNodeRunId: 'nr-review-2',
    result: '已完成',
    destination: { kind: 'finish' },
    selectedAt: at(4),
  },
]

const histories: Record<string, RunHistory> = {
  'review-001': {
    job: runs[1],
    runs: [
      {
        ...common,
        id: 'review-001',
        flowId: 'ordinary',
        flowVersion: 'v1',
        status: 'completed',
        phase: 'completed',
        sequence: 7,
        startedAt: at(0),
        completedAt: at(4),
        variables: { 任务: '评审首页改动' },
      },
    ],
    nodeRuns,
    routeDecisions,
    parallelRounds: [],
    recoveries: [],
  },
  'verify-003': {
    job: runs[2],
    runs: [
      {
        id: 'verify-003',
        runId: 'verify-003',
        flowId: 'release-check',
        flowVersion: 'v1',
        status: 'failed',
        phase: 'failed',
        sequence: 4,
        startedAt: at(10),
        completedAt: at(11),
        error: { category: 'command_execution', summary: '命令退出码 1' },
      },
    ],
    nodeRuns: [
      {
        id: 'nr-verify-1',
        runId: 'verify-003',
        sequence: 2,
        nodeName: '校验发布清单',
        nodeRef: 'verify',
        actionKind: '执行自定义命令',
        status: 'failed',
        startedAt: at(10),
        completedAt: at(11),
        input: {},
        error: { category: 'command_execution', summary: '命令退出码 1' },
        commandResult: {
          status: 'failure',
          exitCode: 1,
          stdout: '',
          stderr: '版本号与 CHANGELOG 不一致：0.1.0 / 0.1.1\n',
        },
        enteredFrom: { kind: 'start' },
      },
    ],
    routeDecisions: [],
    parallelRounds: [],
    recoveries: [],
  },
  'release-002': {
    job: runs[0],
    runs: [
      {
        id: 'release-002',
        runId: 'release-002',
        flowId: 'release-check',
        flowVersion: 'v1',
        status: 'running',
        phase: 'executing_node',
        sequence: 2,
        startedAt: at(20),
        currentNodeRunId: 'nr-release-1',
      },
    ],
    nodeRuns: [
      {
        id: 'nr-release-1',
        runId: 'release-002',
        sequence: 2,
        nodeName: '校验发布清单',
        nodeRef: 'verify',
        actionKind: '执行自定义命令',
        status: 'running',
        startedAt: at(20),
        input: {},
        enteredFrom: { kind: 'start' },
      },
    ],
    routeDecisions: [],
    parallelRounds: [],
    recoveries: [],
  },
  'verify-004': {
    job: runs[3],
    runs: [
      {
        id: 'verify-004',
        runId: 'verify-004',
        flowId: 'release-check',
        flowVersion: 'v1',
        status: 'interrupted',
        phase: 'interrupted',
        sequence: 3,
        startedAt: at(30),
        completedAt: at(31),
      },
    ],
    nodeRuns: [],
    routeDecisions: [],
    parallelRounds: [],
    recoveries: [
      {
        id: 'rc-1',
        sequence: 3,
        strategy: 'fail_command',
        resumedAt: at(31),
        summary: '收到停止请求，命令节点标记为中断',
      },
    ],
  },
}

const readOnly = () =>
  Promise.reject(new ApiError(403, 'demo_read_only', '演示数据不连接 Runtime，不能写入。'))

export const demoSource: Source = {
  mode: 'demo',
  workspace: { name: 'default', path: base.cwd },
  flows: async () => Object.keys(packages),
  flow: async (id) => {
    const found = packages[id]
    if (!found) throw new ApiError(404, 'not_found', 'Flow 不存在')
    return found
  },
  create: readOnly,
  validate: readOnly,
  update: readOnly,
  remove: readOnly,
  start: readOnly,
  runs: async () => runs,
  run: async (id) => {
    const found = runs.find((run) => run.id === id)
    if (!found) throw new ApiError(404, 'not_found', 'Run 不存在')
    return found
  },
  history: async (id) => {
    const found = histories[id]
    if (!found) throw new ApiError(404, 'not_found', 'Run 历史不存在')
    return found
  },
  stop: readOnly,
  config: async () => config,
  configure: readOnly,
}
