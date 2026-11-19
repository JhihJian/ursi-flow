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
