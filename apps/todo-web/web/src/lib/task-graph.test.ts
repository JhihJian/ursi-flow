import { describe, expect, it } from 'vitest'
import type { Task } from '@/api/types'
import { buildTaskGraph, relationCreatesCycle } from './task-graph'

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    creator: 'human',
    created_at: '2026-03-01T09:00:00Z',
    priority: 'medium',
    tags: [],
    status: 'pending',
    artifacts: [],
    ...overrides,
  }
}

function byNodeId(tasks: Task[]) {
  return new Map(buildTaskGraph(tasks).nodes.map((node) => [node.id, node]))
}

describe('buildTaskGraph', () => {
  it('nests children inside their parent instead of drawing an edge', () => {
    const tasks = [task('a'), task('b', { parent_id: 'a' }), task('c', { parent_id: 'b' })]
    const layout = buildTaskGraph(tasks)
    const nodes = byNodeId(tasks)

    expect(layout.roots).toEqual(['a'])
    expect(layout.edges).toEqual([])
    expect(nodes.get('a')!.childIds).toEqual(['b'])
    expect(nodes.get('b')!.childIds).toEqual(['c'])
    // 子节点在父节点框内，逐层缩进。
    expect(nodes.get('b')!.x).toBeGreaterThan(nodes.get('a')!.x)
    expect(nodes.get('b')!.y).toBeGreaterThan(nodes.get('a')!.y)
    expect(nodes.get('c')!.y).toBeGreaterThan(nodes.get('b')!.y)
    expect(nodes.get('a')!.width).toBeGreaterThan(nodes.get('b')!.width)
    expect(nodes.get('a')!.height).toBeGreaterThan(nodes.get('b')!.height)
    expect(nodes.get('c')!.height).toBe(40)
  })

  it('orders siblings by prerequisite and links them vertically', () => {
    const tasks = [
      task('p'),
      task('z', { parent_id: 'p', title: 'Z predecessor' }),
      task('a', { parent_id: 'p', title: 'A successor', pre_id: 'z' }),
    ]
    const layout = buildTaskGraph(tasks)
    const parent = layout.nodes.find((node) => node.id === 'p')!
    const predecessor = layout.nodes.find((node) => node.id === 'z')!
    const successor = layout.nodes.find((node) => node.id === 'a')!

    // 字典序会把 a 排在前面，前置关系要把它压到 z 后面。
    expect(parent.childIds).toEqual(['z', 'a'])
    expect(successor.y).toBeGreaterThan(predecessor.y)
    const edge = layout.edges.find((item) => item.from === 'z' && item.to === 'a')!
    expect(edge.back).toBe(false)
    expect(edge.path).toContain(String(predecessor.x + predecessor.width / 2))
  })

  it('draws a prerequisite edge between open tasks', () => {
    const layout = buildTaskGraph([task('a'), task('b', { pre_id: 'a' })])
    const nodes = byNodeId([task('a'), task('b', { pre_id: 'a' })])

    expect(layout.nodes.map((node) => node.id)).toEqual(['a', 'b'])
    expect(layout.hidden).toBe(0)
    expect(layout.edges).toHaveLength(1)
    expect(layout.edges[0].from).toBe('a')
    expect(layout.edges[0].to).toBe('b')
    expect(nodes.get('a')!.depth).toBe(0)
    expect(nodes.get('b')!.depth).toBe(1)
    expect(layout.width).toBeGreaterThan(0)
    expect(layout.height).toBeGreaterThan(0)
  })

  it('keeps finished tasks only when they link to an open task', () => {
    const tasks = [
      task('open', { pre_id: 'done-pre' }),
      task('done-pre', { status: 'done' }),
      task('done-child', { status: 'done', parent_id: 'open' }),
      task('orphan', { status: 'done' }),
      task('orphan-child', { status: 'cancelled', parent_id: 'orphan' }),
    ]
    const layout = buildTaskGraph(tasks)
    const nodes = byNodeId(tasks)

    expect(layout.nodes.map((node) => node.id).sort()).toEqual(['done-child', 'done-pre', 'open'])
    expect(layout.hidden).toBe(2)
    expect(layout.edges.map((edge) => `${edge.from}->${edge.to}`)).toEqual(['done-pre->open'])
    expect(nodes.get('done-child')!.parentId).toBe('open')
    expect(nodes.get('open')!.childIds).toEqual(['done-child'])
    const shown = new Set(layout.nodes.map((node) => node.id))
    expect(shown.has('orphan')).toBe(false)
    expect(shown.has('orphan-child')).toBe(false)
  })

  it('ignores references to tasks that are not part of the graph', () => {
    const layout = buildTaskGraph([task('a', { pre_id: 'missing', parent_id: 'other-project' })])
    expect(layout.nodes.map((node) => node.id)).toEqual(['a'])
    expect(layout.edges).toEqual([])
    expect(layout.roots).toEqual(['a'])
  })

  it('survives prerequisite cycles and keeps every node', () => {
    const layout = buildTaskGraph([task('a', { pre_id: 'b' }), task('b', { pre_id: 'a' })])
    expect(layout.nodes).toHaveLength(2)
    expect(layout.edges).toHaveLength(2)
    expect(layout.edges.some((edge) => edge.back)).toBe(true)
  })

  it('breaks parent cycles instead of nesting forever', () => {
    const layout = buildTaskGraph([
      task('a', { parent_id: 'b' }),
      task('b', { parent_id: 'a' }),
    ])
    expect(layout.nodes).toHaveLength(2)
    expect(layout.roots).toHaveLength(1)
    expect(layout.nodes.some((node) => node.childIds.length > 0)).toBe(true)
  })

  it('keeps leaf nodes the same size whatever the title length', () => {
    const layout = buildTaskGraph([
      task('short', { title: '短标题' }),
      task('long', { title: '很长的任务标题'.repeat(6) }),
    ])
    expect(layout.nodes).toHaveLength(2)
    expect(layout.nodes[0].width).toBe(layout.nodes[1].width)
    expect(layout.nodes[0].height).toBe(layout.nodes[1].height)
  })

  it('returns an empty layout without tasks', () => {
    expect(buildTaskGraph([])).toEqual({
      nodes: [],
      roots: [],
      edges: [],
      width: 0,
      height: 0,
      hidden: 0,
    })
  })
})

describe('relationCreatesCycle', () => {
  const tasks = [
    task('a'),
    task('b', { parent_id: 'a' }),
    task('c', { parent_id: 'b' }),
    task('x'),
    task('y', { pre_id: 'x' }),
    task('z', { pre_id: 'y' }),
  ]

  it('rejects a parent link that closes the hierarchy', () => {
    // a.parent = c 会让 a → b → c 成环。
    expect(relationCreatesCycle(tasks, 'parent', 'c', 'a')).toBe(true)
    expect(relationCreatesCycle(tasks, 'parent', 'a', 'c')).toBe(false)
    expect(relationCreatesCycle(tasks, 'parent', 'a', 'a')).toBe(true)
  })

  it('rejects a prerequisite link that closes the chain', () => {
    expect(relationCreatesCycle(tasks, 'pre', 'z', 'x')).toBe(true)
    expect(relationCreatesCycle(tasks, 'pre', 'x', 'z')).toBe(false)
  })
})
