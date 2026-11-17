import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createMemoryHistory } from 'vue-router'
import { createMockBackend } from '@/mocks/backend'
import { setApiTransport } from '@/shared/http/client'
import { createAppRouter, navigation } from './router'
import AppShell from './AppShell.vue'

const entries = [
  ['/workflows', '工作流', '工作流'], ['/roles', '角色管理', '角色工作室'], ['/runs', '运行记录', '运行记录'],
  ['/artifacts', '产物管理', '产物管理'], ['/sandboxes', '沙箱管理', '沙箱管理'], ['/connections', '模型连接', '模型连接'],
]
let wrapper: VueWrapper | undefined
beforeEach(() => setApiTransport(createMockBackend(undefined, { delay: 0 }).fetch))
afterEach(() => { wrapper?.unmount(); wrapper = undefined; setApiTransport((...args) => globalThis.fetch(...args)) })

describe('模块装配与导航', () => {
  for (const [path, title, heading] of entries) {
    it(`直接进入 ${path} 渲染业务模块`, async () => {
      const router = createAppRouter(createMemoryHistory())
      await router.push(path)
      await router.isReady()
      wrapper = mount(AppShell, { global: { plugins: [router] } })
      await flushPromises()
      expect(wrapper.get('h1').text()).toBe(heading)
      expect(document.title).toBe(`${title} · ursi-flow`)
      expect(wrapper.get('nav[aria-label="主导航"] a[aria-current="page"]').attributes('href')).toBe(path)
    })
  }
  it('详情路由不进入一级导航', () => { expect(navigation).toHaveLength(6); expect(navigation.some((item) => item.path.includes(':'))).toBe(false) })
  it('首页进入流程页，未知地址可以返回工作流', async () => {
    const router = createAppRouter(createMemoryHistory())
    await router.push('/')
    expect(router.currentRoute.value.path).toBe('/workflows')
    await router.push('/missing-page')
    wrapper = mount(AppShell, { global: { plugins: [router] } })
    await flushPromises()
    expect(wrapper.get('h1').text()).toBe('页面未找到')
    await wrapper.get('main a').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/workflows')
  })
})
