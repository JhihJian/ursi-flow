import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/shared/api'
import type { Run } from '@/shared/api/types'
import { confirmation, finishConfirmation, toasts } from '@/shared/composables/feedback'
import RunDetailView from './RunDetailView.vue'
let current: Run
let wrapper: VueWrapper | undefined
beforeEach(() => {
  current = {
    id: 'run-1', name: '报告交付', workflowId: 'flow-1', workflowName: '报告流程', status: 'waiting', attempt: 1,
    input: '请准备年度报告', sandboxId: 'sandbox-1', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:02Z',
    nodes: [{ id: 'draft', name: '起草', type: 'script', status: 'succeeded', output: '报告草稿已生成' }, { id: 'parallel', name: '独立支路', type: 'script', status: 'succeeded' }, { id: 'review', name: '审阅', type: 'approval', status: 'waiting_approval' }],
    events: [{ id: 'event-1', at: '2026-01-01T00:00:01Z', nodeId: 'draft', type: 'log', message: '已保存草稿' }],
    snapshot: { workflow: { id: 'flow-1', name: '冻结的报告流程', description: '创建时配置', nodes: [{ id: 'draft', name: '起草', type: 'script', script: 'echo report' }, { id: 'review', name: '审阅', type: 'approval' }], edges: [{ source: 'draft', target: 'review' }], updatedAt: '' }, roles: [], connections: [] },
  }
  vi.spyOn(api, 'get').mockImplementation(async path => path.startsWith('/artifacts') ? [] : structuredClone(current))
})
afterEach(() => { wrapper?.unmount(); wrapper = undefined; finishConfirmation(false); toasts.value = []; vi.restoreAllMocks() })
async function setup() {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/runs/:id', component: RunDetailView }, ...['/runs', '/artifacts', '/sandboxes'].map(path => ({ path, component: { template: '<div />' } }))] })
  await router.push('/runs/run-1')
  wrapper = mount({ template: '<RouterView />' }, { global: { plugins: [router], stubs: { teleport: true, transition: false } } })
  await flushPromises()
}
function button(label: string) { return wrapper!.findAll('button').find(value => value.text() === label)! }

describe('运行详情审批与快照', () => {
  it('打回仅列已完成祖先，确认后提交目标并保留历史日志', async () => {
    const post = vi.spyOn(api, 'post').mockImplementation(async () => {
      current = { ...current, status: 'running', attempt: 2, nodes: current.nodes.map(node => node.id === 'draft' ? { ...node, status: 'running' } : node.id === 'review' ? { ...node, status: 'pending' } : node) }
      return structuredClone(current)
    })
    await setup(); await button('打回返工').trigger('click')
    const options = wrapper!.findAll('#reject-run option').map(option => option.text())
    expect(options).toContain('起草'); expect(options).not.toContain('独立支路'); expect(options).not.toContain('审阅')
    await wrapper!.get('#reject-run').trigger('submit'); await flushPromises()
    expect(post).toHaveBeenCalledWith('/runs/run-1/reject', { targetNodeId: 'draft' })
    expect(wrapper!.text()).toContain('第 2 次执行')
    expect(wrapper!.text()).toContain('已保存草稿')
    expect(wrapper!.find('#reject-run').exists()).toBe(false)
  })
  it('403 审批失败展示权限错误并保持等待状态', async () => {
    vi.spyOn(api, 'post').mockRejectedValue(Object.assign(new Error('请求失败'), { status: 403 }))
    await setup(); await button('通过审批').trigger('click'); await flushPromises()
    expect(wrapper!.text()).toContain('403：当前账号没有执行此操作的权限')
    expect(wrapper!.text()).toContain('等待人工审批')
  })
  it('查看任务和冻结流程，取消需确认并以服务终态为准', async () => {
    const post = vi.spyOn(api, 'post').mockImplementation(async () => { current = { ...current, status: 'cancelled' }; return structuredClone(current) })
    await setup(); await button('任务输入').trigger('click')
    expect(wrapper!.text()).toContain('请准备年度报告')
    await button('配置快照').trigger('click')
    expect(wrapper!.text()).toContain('冻结的报告流程')
    await button('取消运行').trigger('click')
    expect(post).not.toHaveBeenCalled(); expect(confirmation.value?.title).toContain('取消这次运行')
    finishConfirmation(true); await flushPromises()
    expect(post).toHaveBeenCalledWith('/runs/run-1/cancel', {})
    expect(wrapper!.text()).toContain('运行已结束')
  })
})
