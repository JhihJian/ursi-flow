import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/shared/api'
import type { Role, Workflow } from '@/shared/api/types'
import { finishConfirmation, confirmation, toasts } from '@/shared/composables/feedback'
import WorkflowsView from './WorkflowsView.vue'
const flow: Workflow = { id: 'flow-1', name: '交付流程', description: '从需求到交付', nodes: [{ id: 'agent', name: '分析', type: 'agent', roleId: 'author' }], edges: [], updatedAt: '2026-01-01T00:00:00Z' }
const roles = [{ id: 'author', name: '分析师' }] as Role[]
let wrapper: VueWrapper | undefined
beforeEach(() => { vi.spyOn(api, 'get').mockImplementation(async path => path === '/roles' ? roles : path === '/workflows' ? [flow] : flow) })
afterEach(() => { wrapper?.unmount(); wrapper = undefined; finishConfirmation(false); toasts.value = []; vi.restoreAllMocks() })
async function setup() {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/workflows', component: WorkflowsView }, { path: '/runs/:id', component: { template: '<div>运行详情</div>' } }] })
  await router.push('/workflows')
  wrapper = mount({ template: '<RouterView />' }, { global: { plugins: [router], stubs: { teleport: true, transition: false } } })
  await flushPromises()
  return router
}
function button(label: string) { return wrapper!.findAll('button').find(value => value.text() === label)! }

describe('工作流界面闭环', () => {
  it('搜索与名称详情展示接口返回的流程图', async () => {
    await setup()
    await wrapper!.get('input[type="search"]').setValue('不存在')
    expect(wrapper!.text()).toContain('没有匹配的工作流')
    await button('清除搜索').trigger('click')
    await button('交付流程').trigger('click'); await flushPromises()
    expect(api.get).toHaveBeenCalledWith('/workflows/flow-1', expect.any(AbortSignal))
    await button('分析智能体').trigger('click')
    expect(wrapper!.text()).toContain('角色：分析师')
  })
  it('新建校验必填，保存失败保留草稿并保护离开', async () => {
    vi.spyOn(api, 'post').mockRejectedValue(new Error('保存失败'))
    await setup(); await button('新建工作流').trigger('click'); await flushPromises()
    await wrapper!.get('#workflow-editor').trigger('submit')
    expect(wrapper!.text()).toContain('请填写工作流名称')
    await wrapper!.get('#workflow-editor input').setValue('新工作流')
    await button('添加节点').trigger('click')
    await wrapper!.get('#workflow-editor').trigger('submit'); await flushPromises()
    expect(api.post).toHaveBeenCalledWith('/workflows', expect.objectContaining({ name: '新工作流', nodes: [expect.objectContaining({ roleId: 'author', type: 'agent' })] }))
    expect(wrapper!.text()).toContain('保存失败')
    expect((wrapper!.get('#workflow-editor input').element as HTMLInputElement).value).toBe('新工作流')
    await button('取消').trigger('click')
    expect(confirmation.value?.title).toContain('未保存')
    finishConfirmation(false); await flushPromises()
    expect(wrapper!.find('#workflow-editor').exists()).toBe(true)
  })
  it('发起运行前验证任务，成功后按响应标识跳转详情', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({ id: 'created-run' })
    const router = await setup(); await button('运行').trigger('click')
    await wrapper!.get('#launch-run').trigger('submit')
    expect(post).not.toHaveBeenCalled()
    await wrapper!.get('#launch-run textarea').setValue('请分析任务并交付报告')
    await wrapper!.get('#launch-run').trigger('submit'); await flushPromises()
    expect(post).toHaveBeenCalledWith('/runs', { workflowId: 'flow-1', input: '请分析任务并交付报告' })
    expect(router.currentRoute.value.path).toBe('/runs/created-run')
  })
})
