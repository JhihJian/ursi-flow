// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'

import { createMockBackend } from '@/mocks/backend'
import { setApiTransport } from '@/shared/http/client'
import { createAppRoutes, navigation } from './router'

const entries = [
  ['/workflows', '工作流', '工作流'],
  ['/roles', '角色管理', '角色工作室'],
  ['/runs', '运行记录', '运行记录'],
  ['/artifacts', '产物管理', '产物管理'],
  ['/sandboxes', '沙箱管理', '沙箱管理'],
  ['/connections', '模型连接', '模型连接'],
  ['/chat', '对话', '对话'],
] as const

function renderAt(path: string) {
  const router = createMemoryRouter(createAppRoutes(), { initialEntries: [path] })
  return { router, ...render(<RouterProvider router={router} />) }
}

beforeEach(() => { setApiTransport(createMockBackend(undefined, { delay: 0 }).fetch) })
afterEach(() => {
  cleanup()
  setApiTransport((...args) => globalThis.fetch(...args))
})

describe('模块装配与导航', () => {
  for (const [path, title, heading] of entries) {
    it(`直接进入 ${path} 渲染业务模块`, async () => {
      renderAt(path)
      const title$ = await screen.findByRole('heading', { level: 1 })
      expect(title$.textContent).toBe(heading)
      await waitFor(() => { expect(document.title).toBe(`${title} · ursi-flow`) })
      const mainNav = screen.getByRole('navigation', { name: '主导航' })
      expect(within(mainNav).getByRole('link', { current: 'page' })).toHaveAttribute('href', path)
    })
  }

  it('详情路由不进入一级导航', () => {
    expect(navigation).toHaveLength(7)
    expect(navigation.map((item) => item.title)).toEqual(['工作流', '角色管理', '运行记录', '对话', '产物管理', '沙箱管理', '模型连接'])
    expect(navigation.some((item) => item.path.includes(':'))).toBe(false)
  })

  it('首页进入流程页，未知地址可以返回工作流', async () => {
    const { router } = renderAt('/')
    await waitFor(() => { expect(router.state.location.pathname).toBe('/workflows') })
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('工作流')

    await act(async () => { await router.navigate('/missing-page') })
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('页面未找到')
    await waitFor(() => { expect(document.title).toBe('页面未找到 · ursi-flow') })

    await userEvent.click(screen.getByRole('link', { name: '返回工作流' }))
    await waitFor(() => { expect(router.state.location.pathname).toBe('/workflows') })
  })
})
