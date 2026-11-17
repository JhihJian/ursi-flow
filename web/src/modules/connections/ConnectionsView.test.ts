import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/shared/api'
import type { Connection } from '@/shared/api/types'
import { confirmation, finishConfirmation, toasts } from '@/shared/composables/feedback'
import ConnectionsView from './ConnectionsView.vue'

const connection: Connection = { id: 'model-1', name: '团队模型', provider: 'OpenAI', baseUrl: 'https://api.example.com/v1', model: 'gpt-4.1', credentialRef: 'env:OPENAI_KEY', updatedAt: '2026-01-01' }
let wrapper: VueWrapper | undefined
beforeEach(() => { vi.spyOn(api, 'get').mockResolvedValue([{ ...connection }]) })
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  finishConfirmation(false)
  toasts.value = []
  vi.restoreAllMocks()
})
async function setup() {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/connections', component: ConnectionsView }] })
  await router.push('/connections')
  wrapper = mount({ template: '<RouterView />' }, { global: { plugins: [router], stubs: { teleport: true, transition: false } } })
  await flushPromises()
  return wrapper
}
function button(label: string) { return wrapper!.findAll('button').find((item) => item.text() === label)! }

describe('连接配置与验证反馈', () => {
  it('编辑使用独立草稿，接口返回后更新卡片', async () => {
    vi.spyOn(api, 'put').mockResolvedValue({ ...connection, name: '新的团队模型' })
    const view = await setup()
    await button('编辑').trigger('click')
    const form = view.get('#connection-form')
    await form.get('input').setValue('新的团队模型')
    expect(view.get('.card-title h2').text()).toBe('团队模型')
    await form.trigger('submit')
    await flushPromises()
    expect(api.put).toHaveBeenCalledWith('/connections/model-1', expect.objectContaining({ name: '新的团队模型', credentialRef: 'env:OPENAI_KEY' }))
    expect(view.get('.card-title h2').text()).toBe('新的团队模型')
  })

  it('保存失败保留草稿与错误，再关闭时确认未保存内容', async () => {
    vi.spyOn(api, 'put').mockRejectedValue(new Error('写入失败，请重试'))
    const view = await setup()
    await button('编辑').trigger('click')
    await view.get('#connection-form input').setValue('待保存名称')
    await view.get('#connection-form').trigger('submit')
    await flushPromises()
    expect(view.get('#connection-form').text()).toContain('写入失败')
    expect((view.get('#connection-form input').element as HTMLInputElement).value).toBe('待保存名称')
    await button('取消').trigger('click')
    expect(confirmation.value?.title).toContain('未保存')
    finishConfirmation(false)
    await flushPromises()
    expect(view.find('#connection-form').exists()).toBe(true)
  })

  it('模拟验证展示 API 消息和零毫秒耗时，失败后可重试', async () => {
    const post = vi.spyOn(api, 'post').mockRejectedValueOnce(new Error('验证服务不可用')).mockResolvedValueOnce({ ok: true, message: '模拟连接验证成功', latency: 0 })
    const view = await setup()
    await button('模拟验证').trigger('click')
    await flushPromises()
    expect(view.get('.test-result').text()).toContain('验证服务不可用')
    await button('模拟验证').trigger('click')
    await flushPromises()
    expect(post).toHaveBeenCalledWith('/connections/model-1/test')
    expect(view.get('.test-result').text()).toContain('模拟连接验证 · 通过')
    expect(view.get('.test-result').text()).toContain('0 ms')
  })

  it('确认删除后呈现引用冲突并保留连接', async () => {
    vi.spyOn(api, 'delete').mockRejectedValue(new Error('连接仍被角色引用，请先调整角色。'))
    const view = await setup()
    await view.get('button[aria-label="删除 团队模型"]').trigger('click')
    expect(confirmation.value?.title).toContain('团队模型')
    finishConfirmation(true)
    await flushPromises()
    expect(view.get('.error-banner').text()).toContain('仍被角色引用')
    expect(view.findAll('.connection-card')).toHaveLength(1)
  })
})
