import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

// 通过 tsx 注册的加载器直接引用 TS 实现，避免在测试里复制一份逻辑。
async function flow(name) {
  return import(join(root, 'src', 'flow', name))
}

test('参考示例的图与节点小节可以双向转换', async () => {
  const { parseFlow, serializeFlow, splitSections, joinSections, syncSections, actionOf, resultsOf } =
    await flow('doc.ts')
  const { graphIssues } = await flow('graph.ts')
  const examples = await import('node:fs/promises').then((fs) =>
    fs.readdir(join(root, '..', 'examples')),
  )
  for (const name of examples) {
    const text = readFileSync(join(root, '..', 'examples', name, 'FLOW.md'), 'utf8')
    const doc = parseFlow(text)
    const again = parseFlow(serializeFlow(doc))
    assert.deepEqual(again.graph, doc.graph, `${name} 图往返`)
    assert.deepEqual(graphIssues(doc.graph), [], `${name} 结构检查`)
    const { prologue, sections } = splitSections(doc.post)
    assert.deepEqual(
      splitSections(joinSections(prologue, sections)).sections,
      sections,
      `${name} 小节往返`,
    )
    // 同步是幂等的：不改结构时正文逐字保留。
    const synced = syncSections(sections, doc.graph, doc.graph)
    assert.deepEqual(synced, sections, `${name} 同步幂等`)
  }
})

test('解析并行点、直连边与结果名', async () => {
  const { parseGraph, outgoing } = await flow('graph.ts')
  const graph = parseGraph(`flowchart TD
  start((开始)) --> check[执行发布检查]
  check -->|通过| finish((结束))
  check -->|返工| fix[修复]
  fix -->|已修复| check
  fix --> parallel{{并行}}
  parallel --> a[测试]
  parallel --> b[检查]
  a -->|已执行| merge[汇总]
  b -->|已执行| merge
  merge -->|已执行| finish`)
  assert.equal(graph.nodes.length, 8)
  assert.equal(graph.nodes.find((node) => node.ref === 'parallel').kind, 'parallel')
  assert.deepEqual(
    outgoing(graph, 'check').map((edge) => edge.result),
    ['通过', '返工'],
  )
  assert.deepEqual(
    outgoing(graph, 'parallel').map((edge) => edge.result),
    [undefined, undefined],
  )
})

test('图结构问题会被报告', async () => {
  const { parseGraph, graphIssues } = await flow('graph.ts')
  const issues = graphIssues(
    parseGraph(`flowchart TD
  start((开始)) --> a[任务]
  a -->|完成| finish((结束))
  orphan[孤立节点]`),
  )
  assert.ok(issues.some((issue) => issue.includes('孤立节点')))
})

test('编辑操作保持图与小节一致', async () => {
  const { parseGraph } = await flow('graph.ts')
  const { addNode, addResult, connect, removeEdge, removeNode, renameResult, retargetEdge } =
    await flow('edit.ts')
  const base = parseGraph(`flowchart TD
  start((开始)) --> a[执行任务]
  a -->|已完成| finish((结束))`)
  const added = addNode(base, 'work')
  assert.equal(added.node.kind, 'work')
  const connected = connect(added.graph, added.node.ref, 'finish')
  assert.equal(connected.edges.at(-1).result, '已执行')
  const renamed = renameResult(connected, connected.edges.at(-1).id, '已交付')
  assert.equal(renamed.edges.at(-1).result, '已交付')
  const retargeted = retargetEdge(renamed, renamed.edges.at(-1).id, 'a')
  assert.equal(retargeted.edges.at(-1).to, 'a')
  const withResult = addResult(retargeted, 'a')
  assert.equal(withResult.edges.filter((edge) => edge.from === 'a').length, 2)
  const extra = withResult.edges.find((edge) => edge.from === 'a' && edge.result === '已执行')
  const trimmed = removeEdge(withResult, extra.id)
  assert.equal(trimmed.edges.filter((edge) => edge.from === 'a').length, 1)
  const deleted = removeNode(trimmed, 'a')
  assert.equal(deleted.nodes.some((node) => node.ref === 'a'), false)
  assert.equal(deleted.edges.some((edge) => edge.from === 'a' || edge.to === 'a'), false)
})

test('布局避开卡片且把回边铺在图形下方', async () => {
  const { parseFlow } = await flow('doc.ts')
  const { layoutGraph, nodeSize, findBackEdges, roundedPath } = await flow('layout.ts')
  const examples = await import('node:fs/promises').then((fs) => fs.readdir(join(root, '..', 'examples')))
  for (const name of examples) {
    const text = readFileSync(join(root, '..', 'examples', name, 'FLOW.md'), 'utf8')
    const graph = parseFlow(text).graph
    const { positions, routes, back } = layoutGraph(graph)
    assert.equal(Object.keys(positions).length, graph.nodes.length, `${name} 每个节点都有坐标`)
    const boxes = graph.nodes.map((node) => {
      const point = positions[node.ref]
      return { ref: node.ref, ...point, ...nodeSize(node, graph) }
    })
    assert.equal(back.size, findBackEdges(graph).size, `${name} 回边识别一致`)

    for (const edge of graph.edges) {
      const route = routes[edge.id]
      assert.ok(route && route.length >= 2, `${name} ${edge.id} 有走线`)
      // 走线中间折点不能落在任何卡片内部。
      for (const point of route) {
        const inside = boxes.find(
          (box) =>
            point.x > box.x + 1 &&
            point.x < box.x + box.width - 1 &&
            point.y > box.y + 1 &&
            point.y < box.y + box.height - 1,
        )
        assert.equal(inside, undefined, `${name} ${edge.id} 的折点压到了 ${inside?.ref}`)
      }
      assert.match(roundedPath(route), /^M /)
    }

    // 回边统一走在所有卡片下方，不会横穿图形。
    const bottom = Math.max(...boxes.map((box) => box.y + box.height))
    for (const edge of graph.edges)
      if (back.has(edge.id))
        for (const point of routes[edge.id]) assert.ok(point.y > bottom, `${name} ${edge.id} 回边在下方`)
  }
})

test('改动作类型时出边按规范收敛', async () => {
  const { parseGraph } = await flow('graph.ts')
  const { setActionKind } = await flow('edit.ts')
  const { parseFlow, serializeFlow, splitSections, joinSections, syncSections } = await flow('doc.ts')

  // Agent 节点改成命令节点：只留一条“已执行”出边。
  const agent = parseGraph(`flowchart TD
  start((开始)) --> a[执行任务]
  a -->|已完成| finish((结束))
  a -->|已失败| b[补救]
  b -->|已完成| finish`)
  const command = setActionKind(agent, 'a', '执行自定义命令')
  assert.deepEqual(
    command.edges.filter((edge) => edge.from === 'a').map((edge) => edge.result),
    ['已执行'],
  )

  // 改成执行Flow：多条普通结果边收敛为一条无结果直连边。
  const single = parseGraph(`flowchart TD
  start((开始)) --> a[执行任务]
  a -->|已完成| finish((结束))`)
  const flowed = setActionKind(single, 'a', '执行Flow')
  assert.deepEqual(
    flowed.edges.filter((edge) => edge.from === 'a').map((edge) => edge.result),
    [undefined],
  )
  // 恰好是 已完成/已失败 两条边时，执行Flow 允许保留，不被改写成直连。
  const pair = setActionKind(agent, 'a', '执行Flow')
  assert.deepEqual(
    pair.edges.filter((edge) => edge.from === 'a').map((edge) => edge.result),
    ['已完成', '已失败'],
  )

  // Agent 节点不能有无结果出边，切换时补默认结果名。
  const bare = parseGraph(`flowchart TD
  start((开始)) --> a[执行任务]
  a --> finish((结束))`)
  assert.deepEqual(
    setActionKind(bare, 'a', '新建Agent')
      .edges.filter((edge) => edge.from === 'a')
      .map((edge) => edge.result),
    ['已完成'],
  )

  // 跨族切换换成默认骨架，族内切换保留正文。
  const doc = parseFlow(`---
name: 示例
description: 示例流程。
---

\`\`\`mermaid
flowchart TD
  start((开始)) --> a[执行任务]
  a -->|已完成| finish((结束))
\`\`\`

## 执行任务

\`\`\`新建Agent
给 Agent 的提示词。
\`\`\`

### 已完成

已完成。
`)
  const next = setActionKind(doc.graph, 'a', '执行自定义命令')
  const { prologue, sections } = splitSections(doc.post)
  const text = serializeFlow({
    ...doc,
    graph: next,
    post: joinSections(prologue, syncSections(sections, doc.graph, next)),
  })
  assert.match(text, /\`\`\`执行自定义命令\n\{/)
  assert.doesNotMatch(text, /给 Agent 的提示词/)
  assert.match(text, /### 已执行\s+节点返回“已执行”时继续执行。/)
})

test('从图写回文本后小节正文不变', async () => {
  const { parseFlow, serializeFlow, splitSections, joinSections, syncSections, resultsOf } = await flow('doc.ts')
  const { renameNode } = await flow('edit.ts')
  const doc = parseFlow(`---
name: 示例
description: 示例流程。
---

\`\`\`mermaid
flowchart TD
  start((开始)) --> a[执行任务]
  a -->|已完成| finish((结束))
\`\`\`

## 执行任务

\`\`\`新建Agent
按任务执行。
\`\`\`

### 已完成

任务已完成。
`)
  const next = renameNode(doc.graph, 'a', '落实任务')
  const { prologue, sections } = splitSections(doc.post)
  const text = serializeFlow({
    ...doc,
    graph: next,
    post: joinSections(prologue, syncSections(sections, doc.graph, next)),
  })
  const reparsed = parseFlow(text)
  assert.match(text, /a\[落实任务\]/)
  assert.match(text, /## 落实任务/)
  const tail = splitSections(reparsed.post).sections[0]
  assert.equal(resultsOf(tail).join(), '已完成')
  assert.match(tail.body, /按任务执行。/)
})

test('启动参数只取声明的全局变量，过程变量不进入表单', async () => {
  const { analyzeParams } = await flow('params.ts')
  const analysis = analyzeParams(`---
name: 代码修改与验证
description: 适用于目标明确的任务。
variables:
  任务:
    description: 本次代码修改目标
  修改记录:
    description: 最新修改与返工记录
    default: 尚未修改
  模型:
    description: 执行用模型
    default: default-model
  阈值:
    description: 重试阈值
    default: 3
---

\`\`\`mermaid
flowchart TD
  start((开始)) --> change[完成修改]
  change -->|已修改| finish((结束))
\`\`\`

## 完成修改

\`\`\`新建Agent
完成以下修改：{var.任务}
使用模型 {var.模型}，阈值 {var.阈值}。
完成后在 variables.修改记录 中提交记录。
\`\`\`

### 已修改

| 变量 | 含义 |
| --- | --- |
| 明细 | 过程汇总 |
`)
  assert.equal(analysis.flowName, '代码修改与验证')
  assert.deepEqual(
    analysis.params.map((param) => param.name),
    ['任务', '模型', '阈值'],
  )
  assert.deepEqual(
    analysis.params.map((param) => [param.name, param.hasDefault, param.kind]),
    [
      ['任务', false, 'text'],
      ['模型', true, 'text'],
      ['阈值', true, 'number'],
    ],
  )
  assert.equal(analysis.params[0].referenced, true)
  assert.deepEqual(
    analysis.internal.map((item) => [item.name, item.initial]),
    [['修改记录', '尚未修改']],
  )
  // 结果变量表里的名字只是下一跳输入，不会变成启动参数。
  assert.ok(!analysis.params.some((param) => param.name === '明细'))
})

test('过程写入但没有默认值的全局变量仍要填写', async () => {
  const { analyzeParams } = await flow('params.ts')
  const analysis = analyzeParams(`---
name: 示例
description: 示例流程。
variables:
  结果:
    description: 由节点写入的最终结果
---

\`\`\`mermaid
flowchart TD
  start((开始)) --> a[执行]
  a -->|已完成| finish((结束))
\`\`\`

## 执行

\`\`\`新建Agent
请在 variables.结果 中提交结论。
\`\`\`

### 已完成

已提交。
`)
  assert.deepEqual(analysis.internal, [])
  assert.deepEqual(
    analysis.params.map((param) => [param.name, param.hasDefault]),
    [['结果', false]],
  )
})

test('元信息异常与取值转换', async () => {
  const { analyzeParams, toText, toValue } = await flow('params.ts')
  assert.equal(analyzeParams('没有元信息').error?.includes('缺少元信息'), true)
  assert.equal(analyzeParams('---\nvariables: [1, 2\n---\n').error?.includes('YAML'), true)
  const param = { name: '阈值', description: '', hasDefault: true, kind: 'number', referenced: true, default: 3 }
  assert.deepEqual(toValue(param, '5'), { value: 5 })
  assert.equal(toValue(param, 'abc').error, '必须是数字')
  assert.deepEqual(toValue({ ...param, kind: 'json' }, '{"a":1}'), { value: { a: 1 } })
  assert.equal(toText({ a: 1 }), '{\n  "a": 1\n}')
  assert.equal(toText(undefined), '')
})

test('提示词里用「全局变量 `x`」写回的变量同样算过程变量', async () => {
  const { analyzeParams } = await flow('params.ts')
  const analysis = analyzeParams(`---
name: 评审
description: 评审与修复。
variables:
  任务:
    description: 评审任务
  评审记录:
    description: 评审进度
    default: 尚未评审
---

\`\`\`mermaid
flowchart TD
  start((开始)) --> a[评审]
  a -->|已完成| finish((结束))
\`\`\`

## 评审

\`\`\`新建Agent
评审 {var.任务}，参考 {var.评审记录}。
\`\`\`

### 已完成

更新全局变量 \`评审记录\` 后再继续。
`)
  assert.deepEqual(analysis.params.map((param) => param.name), ['任务'])
  assert.deepEqual(analysis.internal.map((item) => item.name), ['评审记录'])
})

test('运行事实映射到流转图的节点状态与实际走过的边', async () => {
  const { parseGraph } = await flow('graph.ts')
  const { runFlowState } = await flow('run-state.ts')
  const graph = parseGraph(`
flowchart TD
  start((开始)) --> plan[确认计划]
  plan -->|通过| merge[汇合结果]
  plan -->|返工| plan
  merge -->|已执行| finish((结束))
`)
  const nodeRun = (id, ref, sequence, status, extra = {}) => ({
    id,
    runId: 'run-1',
    sequence,
    nodeRef: ref,
    actionKind: '执行自定义命令',
    input: {},
    status,
    startedAt: '2025-01-08T09:00:00.000Z',
    enteredFrom: { kind: 'start' },
    ...extra,
  })
  const facts = {
    job: {},
    runs: [{ id: 'run-1', status: 'running', currentNodeRef: 'merge' }],
    nodeRuns: [
      nodeRun('n1', 'plan', 2, 'completed', { outcome: { result: '通过' } }),
      nodeRun('n2', 'merge', 4, 'running'),
    ],
    routeDecisions: [
      {
        id: 'r1',
        runId: 'run-1',
        sequence: 3,
        sourceNodeRunId: 'n1',
        result: '通过',
        destination: { kind: 'node', ref: 'merge' },
        selectedAt: '2025-01-08T09:00:02.000Z',
      },
    ],
    parallelRounds: [],
    recoveries: [],
  }
  const state = runFlowState(graph, facts.runs[0], facts)
  assert.equal(state.nodes.plan.status, 'completed')
  assert.equal(state.nodes.plan.visits, 1)
  assert.equal(state.nodes.merge.status, 'running')
  assert.equal(state.currentRef, 'merge')
  // 开始边由首个访问记录确认，路由边由路由决策确认，没走的回边保持未访问。
  assert.equal(state.edges['start||plan'].traversed, 1)
  assert.equal(state.edges['plan|通过|merge'].traversed, 1)
  assert.equal(state.edges['plan|返工|plan'], undefined)
})
