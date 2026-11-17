import { describe, expect, it } from 'vitest'
import type { Run, RunEvent } from '@/shared/api/types'
import { completedAncestors, mergeEvents } from './runState'
const event = (id: string, at = '2026-01-01T00:00:00Z'): RunEvent => ({ id, at, type: 'state', message: id })
describe('运行事件与返工目标', () => {
  it('重复轮询去重，返工历史序号稳定，追加迟到事件不重排已有记录', () => {
    const initial = mergeEvents([], [event('2'), event('1'), event('2')])
    expect(initial.map(value => value.id)).toEqual(['1', '2'])
    const next = mergeEvents(initial, [event('2'), event('3'), event('late', '2025-01-01T00:00:00Z')])
    expect(next.map(value => [value.id, value.sequence])).toEqual([['1', 1], ['2', 2], ['late', 3], ['3', 4]])
  })
  it('仅允许已完成的传递祖先，不包含并行支路、后继和审批自身', () => {
    const run = {
      nodes: [
        { id: 'a', status: 'succeeded' }, { id: 'b', status: 'succeeded' },
        { id: 'parallel', status: 'succeeded' }, { id: 'review', status: 'waiting_approval' },
        { id: 'after', status: 'pending' }, { id: 'failed', status: 'failed' },
      ],
      snapshot: { workflow: { edges: [{ source: 'a', target: 'b' }, { source: 'b', target: 'review' }, { source: 'failed', target: 'review' }, { source: 'review', target: 'after' }] } },
    } as Run
    expect(completedAncestors(run).map(node => node.id)).toEqual(['a', 'b'])
  })
})
