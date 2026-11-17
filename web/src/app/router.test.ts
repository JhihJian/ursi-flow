import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createMemoryHistory } from 'vue-router'
import { createAppRouter } from './router'
import AppShell from './AppShell.vue'

const entries = [
  ['/workflows', '工作流'], ['/roles', '角色管理'], ['/runs', '运行记录'],
  ['/artifacts', '产物管理'], ['/sandboxes', '沙箱管理'], ['/connections', '模型连接'],
]
let wrapper: VueWrapper | undefined

afterEach(() => { wrapper?.unmount(); wrapper = undefined })

describe('模块装配与导航', () => {
  for (const [path, title] of entries) {
    it(`直接进入 ${path} 渲染真实模块入口`, async () => {
      const router = createAppRouter(createMemoryHistory())
      await router.push(path)
      await router.isReady()
      wrapper = mount(AppShell, { global: { plugins: [router] } })
      await flushPromises()
      expect(wrapper.get('h1').text()).toBe(title)
      expect(document.title).toBe(`${title} · ursi-flow`)
      expect(wrapper.text()).toContain('功能准备中')
      expect(wrapper.get('nav a[aria-current="page"]').attributes('href')).toBe(path)
    })
  }

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
