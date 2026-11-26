import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { readSettings, writeSettings } from './config.ts'
import { listFlows, readFlow } from './flows.ts'
import { createRunService } from './runs.ts'

const dirs: string[] = []

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const AGENT_FLOW = `---
name: 两步流程
description: 两个串行 Agent 节点。
variables:
  任务:
    description: 本次任务
---

\`\`\`mermaid
flowchart TD
  start((开始)) --> analyze[分析]
  analyze -->|已分析| finishNode[收尾]
  finishNode -->|已完成| finish((结束))
\`\`\`

## 分析
\`\`\`新建Agent
分析 {var.任务}
\`\`\`
### 已分析
| 变量 | 含义 |
| --- | --- |
| 结论 | 分析结论 |

## 收尾
\`\`\`新建Agent
根据 {input.结论} 收尾
\`\`\`
### 已完成
完成。
`

const CONFIRM_FLOW = `---
name: 确认门禁
description: 一步 Agent 后等待人工确认。
---

\`\`\`mermaid
flowchart TD
  start((开始)) --> prepare[准备]
  prepare -->|已准备| gate[确认]
  gate -->|通过| finish((结束))
  gate -->|退回| prepare
\`\`\`

## 准备
\`\`\`新建Agent
准备材料
\`\`\`
### 已准备
准备完成。

## 确认
\`\`\`confirm
请确认准备结果。
\`\`\`
### 通过
通过。

### 退回
退回。
`

async function writeFlow(home: string, id: string, text: string): Promise<void> {
  await mkdir(join(home, id), { recursive: true })
  await writeFile(join(home, id, 'FLOW.md'), text, 'utf8')
}

test('flow home 默认是 ~/.ursi/flow，保存时创建目录并拒绝相对路径', async () => {
  const state = await tempDir('flow-web-state-')
  const settings = await readSettings(state)
  assert.match(settings.flowHome, /\.ursi\/flow$/)

  const home = join(state, 'flows')
  const saved = await writeSettings(state, { flowHome: home })
  assert.equal(saved.flowHome, home)
  assert.equal((await readSettings(state)).flowHome, home)

  await assert.rejects(
    () => writeSettings(state, { flowHome: 'relative/dir' }),
    /绝对路径/,
  )
})

test('列出 Flow 包并解析结构与变量', async () => {
  const home = await tempDir('flow-web-home-')
  await writeFlow(home, 'two-steps', AGENT_FLOW)
  await writeFlow(home, 'broken', '这不是 Flow')
  await mkdir(join(home, 'not-a-flow'))

  const flows = await listFlows(home)
  assert.deepEqual(
    flows.map((flow) => [flow.id, flow.valid]),
    [
      ['broken', false],
      ['two-steps', true],
    ],
  )
  const good = flows.find((flow) => flow.id === 'two-steps')!
  assert.equal(good.name, '两步流程')
  assert.equal(good.nodeCount, 2)
  assert.equal(good.variableCount, 1)

  const detail = await readFlow(home, 'two-steps')
  assert.deepEqual(detail.variables, [
    { name: '任务', description: '本次任务', required: true },
  ])
  assert.deepEqual(
    detail.nodes.map((node) => [node.kind, node.name]),
    [
      ['agent', '分析'],
      ['agent', '收尾'],
    ],
  )
  assert.deepEqual(
    detail.nodes[0].outcomes.map((outcome) => [
      outcome.name,
      outcome.destination.kind,
      outcome.destination.name,
    ]),
    [['已分析', 'node', '收尾']],
  )
})

test('Flow 标识不允许路径分隔与上跳', async () => {
  const home = await tempDir('flow-web-home-')
  await assert.rejects(() => readFlow(home, '../etc'), /非法的 Flow 标识/)
  await assert.rejects(() => readFlow(home, 'a/b'), /非法的 Flow 标识/)
})

test('启动运行到完成，运行可查询、可列出', async () => {
  const home = await tempDir('flow-web-home-')
  const state = await tempDir('flow-web-state-')
  await writeFlow(home, 'two-steps', AGENT_FLOW)
  const detail = await readFlow(home, 'two-steps')
  const service = createRunService({ runsRoot: join(state, 'runs') })

  const { runId } = await service.start({
    flow: { id: detail.id, text: AGENT_FLOW, path: detail.path },
    variables: { 任务: '补测试' },
  })

  const view = await waitFor(service, runId)
  assert.equal(view.status, 'completed')
  assert.equal(view.stepCount, 2)
  assert.deepEqual(view.variables, { 任务: '补测试' })
  assert.ok(view.events.some((event) => event.type === 'run.completed'))

  assert.equal(view.executor, 'fake')

  const runs = await service.list()
  assert.equal(runs.length, 1)
  assert.equal(runs[0].runId, runId)
  assert.equal(runs[0].status, 'completed')
  assert.equal(runs[0].flowId, 'two-steps')
  assert.equal(runs[0].executor, 'fake')
})

test('缺少必填变量时启动同步失败，不留运行目录', async () => {
  const home = await tempDir('flow-web-home-')
  const state = await tempDir('flow-web-state-')
  await writeFlow(home, 'two-steps', AGENT_FLOW)
  const detail = await readFlow(home, 'two-steps')
  const service = createRunService({ runsRoot: join(state, 'runs') })

  await assert.rejects(
    () =>
      service.start({
        flow: { id: detail.id, text: AGENT_FLOW, path: detail.path },
        variables: {},
      }),
    /缺少必填全局变量/,
  )
  assert.deepEqual(await service.list(), [])
})

test('执行器按 id 选择：未接入的 id 同步拒绝，默认 id 来自清单第一位', async () => {
  const home = await tempDir('flow-web-home-')
  const state = await tempDir('flow-web-state-')
  await writeFlow(home, 'two-steps', AGENT_FLOW)
  const detail = await readFlow(home, 'two-steps')
  const service = createRunService({ runsRoot: join(state, 'runs') })

  assert.deepEqual(
    service.executors().map((adapter) => adapter.id),
    ['fake'],
  )
  assert.equal(service.defaultExecutor(), 'fake')
  await assert.rejects(
    () =>
      service.start({
        flow: { id: detail.id, text: AGENT_FLOW, path: detail.path },
        variables: { 任务: 'x' },
        executor: 'pi',
      }),
    /未接入的执行器：pi/,
  )
})

test('换一套适配器后旧运行不会接到新执行器上', async () => {
  const home = await tempDir('flow-web-home-')
  const state = await tempDir('flow-web-state-')
  await writeFlow(home, 'gate', CONFIRM_FLOW)
  const detail = await readFlow(home, 'gate')
  const runsRoot = join(state, 'runs')
  const first = createRunService({ runsRoot })
  const { runId } = await first.start({
    flow: { id: detail.id, text: CONFIRM_FLOW, path: detail.path },
  })
  await waitForStatus(first, runId, 'awaiting_input')

  const second = createRunService({
    runsRoot,
    adapters: [
      {
        id: 'other',
        title: '另一个执行器',
        description: '',
        create: () => ({
          id: 'other',
          prompt: async () => ({ outcome: '通过' }),
          command: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
        }),
      },
    ],
  })
  const viewed = await second.view(runId)
  assert.equal(viewed?.executor, 'fake')
  await assert.rejects(() => second.resume(runId), /未接入的执行器：fake/)
})

test('确认门禁：非法结果被拒，合法结果继续到完成', async () => {
  const home = await tempDir('flow-web-home-')
  const state = await tempDir('flow-web-state-')
  await writeFlow(home, 'gate', CONFIRM_FLOW)
  const detail = await readFlow(home, 'gate')
  const service = createRunService({ runsRoot: join(state, 'runs') })

  const { runId } = await service.start({
    flow: { id: detail.id, text: CONFIRM_FLOW, path: detail.path },
  })
  const waiting = await waitForStatus(service, runId, 'awaiting_input')
  assert.equal(waiting.pending?.nodeName, '确认')
  assert.deepEqual(waiting.pending?.options, ['通过', '退回'])

  await assert.rejects(
    () => service.confirm(runId, waiting.pending!.stepId, '不合法'),
    /无效的确认结果/,
  )
  const done = await service.confirm(runId, waiting.pending!.stepId, '通过')
  assert.equal(done.status, 'completed')
})

test('等待中的运行可以停止，已结束的运行原样返回', async () => {
  const home = await tempDir('flow-web-home-')
  const state = await tempDir('flow-web-state-')
  await writeFlow(home, 'gate', CONFIRM_FLOW)
  const detail = await readFlow(home, 'gate')
  const service = createRunService({ runsRoot: join(state, 'runs') })

  const { runId } = await service.start({
    flow: { id: detail.id, text: CONFIRM_FLOW, path: detail.path },
  })
  await waitForStatus(service, runId, 'awaiting_input')
  const stopped = await service.stop(runId, '用户停止')
  assert.equal(stopped.status, 'interrupted')
  assert.equal((await service.stop(runId)).status, 'interrupted')
})

async function waitFor(service: ReturnType<typeof createRunService>, runId: string) {
  return waitForStatus(service, runId, 'completed')
}

async function waitForStatus(
  service: ReturnType<typeof createRunService>,
  runId: string,
  status: string,
) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const view = await service.view(runId)
    if (view !== undefined && view.status === status && !view.active) return view
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`运行 ${runId} 未进入 ${status}`)
}
