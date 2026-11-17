import { defineComponent, ref } from 'vue'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/shared/api'
import type { Run } from '@/shared/api/types'
import { useRunDetail } from './useRunDetail'

function fixture(status: Run['status'] = 'running', id = 'run-1'): Run {
  return { id, name: '任务', workflowId: 'flow-1', workflowName: '工作流', status, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:01Z', attempt: 1, nodes: [], snapshot: { workflow: { id: 'flow-1', name: '工作流', description: '', nodes: [], edges: [], updatedAt: '' }, roles: [], connections: [] }, input: '执行任务', sandboxId: 'box-1', events: [] }
}
let wrapper: VueWrapper | undefined
let state: ReturnType<typeof useRunDetail>
const id = ref('run-1')
function setup() {
  wrapper = mount(defineComponent({ setup() { state = useRunDetail(() => id.value); return () => null } }))
}
beforeEach(() => { vi.useFakeTimers(); id.value = 'run-1' })
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.restoreAllMocks(); vi.useRealTimers() })

describe('运行详情串行轮询', () => {
  it('每轮完成后等待 1500ms，慢请求不重叠，终态停止', async () => {
    let resolveSlow!: (run: Run) => void
    let reads = 0
    const get = vi.spyOn(api, 'get').mockImplementation(async path => {
      if (path.startsWith('/artifacts')) return []
      reads++
      if (reads === 2) return new Promise<Run>(resolve => { resolveSlow = resolve })
      return fixture()
    })
    setup(); await flushPromises()
    expect(reads).toBe(1)
    await vi.advanceTimersByTimeAsync(1500); await flushPromises()
    expect(reads).toBe(2)
    await vi.advanceTimersByTimeAsync(9000)
    expect(reads).toBe(2)
    resolveSlow(fixture('succeeded')); await flushPromises()
    expect(state.run.value?.status).toBe('succeeded')
    await vi.advanceTimersByTimeAsync(6000)
    expect(reads).toBe(2)
    expect(get).toHaveBeenCalledWith('/artifacts?runId=run-1', expect.any(AbortSignal))
  })
  it('卸载取消在途请求并清理计时器', async () => {
    let signal: AbortSignal | undefined
    vi.spyOn(api, 'get').mockImplementation((_path, value) => { signal = value; return new Promise(() => {}) })
    setup()
    expect(signal?.aborted).toBe(false)
    wrapper!.unmount(); wrapper = undefined
    expect(signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('换运行时忽略旧响应，清空事件序号与产物', async () => {
    let resolveOld!: (value: Run) => void
    vi.spyOn(api, 'get').mockImplementation(async path => {
      if (path.startsWith('/artifacts')) return []
      if (path === '/runs/run-1') return new Promise<Run>(resolve => { resolveOld = resolve })
      return fixture('failed', 'run-2')
    })
    setup(); id.value = 'run-2'; await flushPromises()
    expect(state.run.value?.id).toBe('run-2')
    resolveOld(fixture()); await flushPromises()
    expect(state.run.value?.id).toBe('run-2')
    expect(vi.getTimerCount()).toBe(0)
  })
  it('审批防止重复提交，冲突保留错误并重新读取状态', async () => {
    vi.spyOn(api, 'get').mockImplementation(async path => path.startsWith('/artifacts') ? [] : fixture('waiting'))
    let rejectAction!: (error: Error) => void
    const post = vi.spyOn(api, 'post').mockImplementation(() => new Promise((_resolve, reject) => { rejectAction = reject }))
    setup(); await flushPromises()
    const first = state.act('approve'); await flushPromises()
    expect(await state.act('approve')).toBe(false)
    expect(post).toHaveBeenCalledTimes(1)
    rejectAction(new Error('409：运行状态已变化'))
    expect(await first).toBe(false); await flushPromises()
    expect(state.actionError.value).toContain('409')
    expect(state.saving.value).toBe(false)
  })
})
