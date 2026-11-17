import { defineComponent, h, ref } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/shared/api'
import type { Workflow } from '@/shared/api/types'
import { confirmation, finishConfirmation, toasts } from '@/shared/composables/feedback'
import RunLaunchModal from './RunLaunchModal.vue'

const workflow: Workflow = { id: 'flow-1', name: '交付流程', description: '', nodes: [], edges: [], updatedAt: '2026-01-01' }
let wrapper: VueWrapper | undefined
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: Error) => void
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline })
  return { promise, resolve, reject }
}
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  finishConfirmation(false)
  toasts.value = []
  vi.restoreAllMocks()
})
async function setup() {
  const close = vi.fn()
  const Page = defineComponent({
    setup() {
      const open = ref(true)
      return () => open.value ? h(RunLaunchModal, { workflow, onClose: () => { close(); open.value = false } }) : null
    },
  })
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/elsewhere', component: { template: '<div>其他页面</div>' } },
    { path: '/workflows', component: Page },
    { path: '/runs/:id', component: { template: '<div>运行详情</div>' } },
  ] })
  await router.push('/elsewhere?section=keep')
  await router.push('/workflows')
  wrapper = mount(RouterView, { global: { plugins: [router], stubs: { teleport: true, transition: false } } })
  await flushPromises()
  return { router, close }
}

describe('运行弹窗异步操作生命周期', () => {
  it.each(['resolve', 'reject'] as const)('提交后浏览器后退确认离开，迟到的 %s 不跳转或通知', async (outcome) => {
    const pending = deferred<{ id: string }>()
    const post = vi.spyOn(api, 'post').mockReturnValueOnce(pending.promise)
    const { router, close } = await setup()
    await wrapper!.get('textarea').setValue('交付报告')
    await wrapper!.get('form').trigger('submit')
    expect(post).toHaveBeenCalledWith('/runs', { workflowId: workflow.id, input: '交付报告' })
    router.back()
    await flushPromises()
    expect(confirmation.value?.title).toContain('未保存')
    finishConfirmation(true)
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/elsewhere?section=keep')
    expect(wrapper!.findComponent(RunLaunchModal).exists()).toBe(false)
    const push = vi.spyOn(router, 'push')
    if (outcome === 'resolve') pending.resolve({ id: 'late-run' })
    else pending.reject(new Error('迟到的错误'))
    await flushPromises()
    expect(push).not.toHaveBeenCalled()
    expect(router.currentRoute.value.fullPath).toBe('/elsewhere?section=keep')
    expect(close).not.toHaveBeenCalled()
    expect(toasts.value).toEqual([])
  })

  it('取消填写的确认等待期间卸载，确认后不触发关闭事件', async () => {
    const { close } = await setup()
    await wrapper!.get('textarea').setValue('未提交任务')
    await wrapper!.get('button[aria-label="关闭"]').trigger('click')
    expect(confirmation.value).not.toBeNull()
    wrapper!.unmount()
    wrapper = undefined
    finishConfirmation(true)
    await flushPromises()
    expect(close).not.toHaveBeenCalled()
    expect(toasts.value).toEqual([])
  })

  it('仍在页面时请求成功，显示反馈并跳转返回的运行', async () => {
    const pending = deferred<{ id: string }>()
    vi.spyOn(api, 'post').mockReturnValueOnce(pending.promise)
    const { router, close } = await setup()
    await wrapper!.get('textarea').setValue('交付报告')
    await wrapper!.get('form').trigger('submit')
    pending.resolve({ id: 'created-run' })
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/runs/created-run')
    expect(close).toHaveBeenCalledTimes(1)
    expect(toasts.value.map(toast => toast.message)).toEqual(['运行已创建'])
  })

  it('仍在页面时请求失败，保留输入并允许重试', async () => {
    const pending = deferred<{ id: string }>()
    vi.spyOn(api, 'post').mockReturnValueOnce(pending.promise)
    const { router, close } = await setup()
    await wrapper!.get('textarea').setValue('交付报告')
    await wrapper!.get('form').trigger('submit')
    pending.reject(new Error('创建失败'))
    await flushPromises()
    expect(wrapper!.get('[role="alert"]').text()).toBe('创建失败')
    expect((wrapper!.get('textarea').element as HTMLTextAreaElement).value).toBe('交付报告')
    expect(wrapper!.get('button[type="submit"]').attributes('disabled')).toBeUndefined()
    expect(router.currentRoute.value.path).toBe('/workflows')
    expect(close).not.toHaveBeenCalled()
    expect(toasts.value).toEqual([])
  })
})
