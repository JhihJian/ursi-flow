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

function edgeKeys(tasks: Task[]): string[] {
  return buildTaskGraph(tasks)
    .edges.map((edge) => `${edge.from}->${edge.to}:${edge.kind}`)
    .sort()
}

describe('buildTaskGraph', () => {
  it('draws parent and prerequisite edges between open tasks', () => {
    const tasks = [task('a'), task('b', { parent_id: 'a' }), task('c', { pre_id: 'b' })]
    const layout = buildTaskGraph(tasks)

    expect(layout.nodes.map((node) => node.id)).toEqual(['a', 'b', 'c'])
    expect(layout.hidden).toBe(0)
    expect(edgeKeys(tasks)).toEqual(['a->b:parent', 'b->c:pre'])
    expect(layout.nodes.map((node) => node.depth)).toEqual([0, 1, 2])
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

    expect(layout.nodes.map((node) => node.id).sort()).toEqual(['done-child', 'done-pre', 'open'])
    expect(layout.hidden).toBe(2)
    expect(edgeKeys(tasks)).toEqual(['done-pre->open:pre', 'open->done-child:parent'])
    const shown = new Set(layout.nodes.map((node) => node.id))
    expect(shown.has('orphan')).toBe(false)
    expect(shown.has('orphan-child')).toBe(false)
  })

  it('ignores references to tasks that are not part of the graph', () => {
    const layout = buildTaskGraph([task('a', { pre_id: 'missing', parent_id: 'other-project' })])
    expect(layout.nodes.map((node) => node.id)).toEqual(['a'])
    expect(layout.edges).toEqual([])
  })

  it('survives prerequisite cycles and keeps every node', () => {
    const layout = buildTaskGraph([task('a', { pre_id: 'b' }), task('b', { pre_id: 'a' })])
    expect(layout.nodes).toHaveLength(2)
    expect(layout.edges).toHaveLength(2)
    expect(layout.edges.some((edge) => edge.back)).toBe(true)
  })

  it('keeps every node the same size whatever the title length', () => {
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
