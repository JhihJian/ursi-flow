// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'

import { setToken } from '@/shared/http/session'
import { vi } from 'vitest'
import { useFeedbackStore } from '@/shared/stores/feedback'
import { createAppRoutes } from './router'
import { initTheme, PALETTE_STORAGE_KEY, THEME_STORAGE_KEY, useThemeStore } from './theme'

function renderAt(path: string) {
  const router = createMemoryRouter(createAppRoutes(), { initialEntries: [path] })
  return { router, ...render(<RouterProvider router={router} />) }
}

beforeAll(() => { initTheme() })
beforeEach(() => {
  setToken('test')
  vi.stubGlobal('fetch', vi.fn(async () => Response.json([])))
  window.localStorage.clear()
  useFeedbackStore.setState({ toasts: [], confirmation: null })
  useThemeStore.getState().setMode('light')
  useThemeStore.getState().setPalette('color')
})
afterEach(() => {
  cleanup()
  sessionStorage.clear()
})

describe('应用壳', () => {
  it('侧边导航切换页面并更新标题、面包屑与当前项', async () => {
    const { router } = renderAt('/flows')
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('Flow 包')
    expect(screen.getByRole('link', { name: 'ursi-flow 首页' })).toHaveAttribute('href', '/items')
    expect(screen.getByRole('link', { name: '跳到主要内容' })).toHaveAttribute('href', '#main-content')

    const mainNav = screen.getByRole('navigation', { name: '主导航' })
    for (const [name, href] of [['工作清单', '/items'], ['工作包', '/workspaces'], ['外部来源', '/sources'], ['SOP', '/sops'], ['派工模板', '/templates'], ['资源库', '/resources'], ['执行器', '/executors']]) {
      expect(within(mainNav).getByRole('link', { name })).toHaveAttribute('href', href)
    }
    expect(within(mainNav).getByRole('link', { current: 'page' })).toHaveTextContent('Flow 包')

    await userEvent.click(within(mainNav).getByRole('link', { name: '运行记录' }))
    await waitFor(() => { expect(router.state.location.pathname).toBe('/runs') })
    expect(await screen.findByRole('heading', { level: 1, name: '运行记录' })).toBeVisible()
    await waitFor(() => { expect(document.title).toBe('运行记录 · ursi-flow') })
    expect(within(screen.getByRole('navigation', { name: '主导航' })).getByRole('link', { current: 'page' })).toHaveAttribute('href', '/runs')
    expect(within(screen.getByRole('navigation', { name: '面包屑' })).getByText('运行记录')).toHaveAttribute('aria-current', 'page')

    await userEvent.click(within(screen.getByRole('navigation', { name: '主导航' })).getByRole('link', { name: '对话' }))
    await waitFor(() => { expect(router.state.location.pathname).toBe('/chat') })
    await waitFor(() => { expect(document.title).toBe('对话 · ursi-flow') })
  })

  it('移动抽屉展示工作区导航并在导航后关闭', async () => {
    const { router } = renderAt('/flows')
    await screen.findByRole('heading', { level: 1 })

    await userEvent.click(screen.getByRole('button', { name: '打开导航菜单' }))
    const drawer = await screen.findByRole('dialog', { name: '工作区导航' })
    expect(within(drawer).getByRole('link', { name: '工作清单' })).toHaveAttribute('href', '/items')
    await userEvent.click(within(drawer).getByRole('link', { name: '运行配置' }))

    await waitFor(() => { expect(router.state.location.pathname).toBe('/flow-config') })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('运行配置')
  })

  it('只有集合 404 收起对应模块，空集合仍可进入；故障保留入口并可单独重试', async () => {
    let status = 503
    const fetch = vi.fn(async (path: string) => Response.json([], { status: path === '/api/v1/flows' ? 404 : status }))
    vi.stubGlobal('fetch', fetch)
    renderAt('/missing')
    const nav = within(screen.getByRole('navigation', { name: '主导航' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 503')
    for (const name of ['Flow 包', '运行记录', '运行配置']) expect(nav.queryByRole('link', { name })).toBeNull()
    expect(nav.getByRole('link', { name: '工作清单' })).toBeInTheDocument()
    expect(nav.getByRole('link', { name: '外部来源' })).toBeInTheDocument()
    status = 200
    await userEvent.click(screen.getByRole('button', { name: '重试外部来源' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(nav.getByRole('link', { name: '外部来源' })).toBeInTheDocument()
    expect(fetch.mock.calls.map(([path]) => path).sort()).toEqual(['/api/v1/flows', '/api/v2/sources', '/api/v2/sources'])
  })

  it('来源未挂载时保留 Flow 工具，来源深链提供返回清单入口', async () => {
    vi.stubGlobal('fetch', vi.fn(async (path: string) => Response.json([], { status: path === '/api/v2/sources' ? 404 : 200 })))
    renderAt('/sources')
    expect(await screen.findByRole('heading', { name: '外部来源未启用' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '返回工作清单' })).toHaveAttribute('href', '/items')
    const nav = within(screen.getByRole('navigation', { name: '主导航' }))
    expect(nav.queryByRole('link', { name: '外部来源' })).toBeNull()
    expect(nav.getByRole('link', { name: 'Flow 包' })).toBeInTheDocument()
  })

  it('桌面侧栏与移动抽屉提供相同分组和入口', async () => {
    renderAt('/flows')
    await screen.findByRole('heading', { level: 1 })
    const entries = (nav: HTMLElement) => [...nav.querySelectorAll('a')].map(link => [link.textContent, link.getAttribute('href')])
    const [desktop] = screen.getAllByRole('navigation', { name: '主导航' })
    const desktopEntries = entries(desktop!)
    expect(desktopEntries.map(([title]) => title)).toEqual(expect.arrayContaining(['工作清单', '工作包', '外部来源', 'SOP', '派工模板', '资源库', '执行器', 'Flow 包', '运行记录', '运行配置', '对话']))

    await userEvent.click(screen.getByRole('button', { name: '打开导航菜单' }))
    const drawer = await screen.findByRole('dialog', { name: '工作区导航' })
    expect(entries(within(drawer).getByRole('navigation', { name: '主导航' }))).toEqual(desktopEntries)
    for (const group of ['日常工作', '工作定义', '运行工具', '本地演示']) {
      expect(within(drawer).getByRole('heading', { name: group })).toBeInTheDocument()
    }
  })

  it('可选模块探测失败时仍能使用工作清单并单独重试', async () => {
    let sourcesCalls = 0
    const fetch = vi.fn(async (path: string) => {
      if (path === '/api/v2/items') return Response.json([])
      if (path === '/api/v2/sources') { sourcesCalls += 1; return sourcesCalls === 1 ? Response.json([], { status: 503 }) : Response.json([]) }
      return Response.json([], { status: 503 })
    })
    vi.stubGlobal('fetch', fetch)
    renderAt('/items')
    expect(await screen.findByText('暂无工作项')).toBeInTheDocument()
    expect(await screen.findByText(/外部来源检查失败：HTTP 503/)).toBeInTheDocument()
    expect(screen.getByText(/Flow 工具检查失败：HTTP 503/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '重试外部来源' }))
    await waitFor(() => { expect(screen.queryByText(/外部来源检查失败/)).toBeNull() })
    expect(screen.getByText(/Flow 工具检查失败/)).toBeInTheDocument()
    expect(screen.getByText('暂无工作项')).toBeInTheDocument()
    expect(fetch.mock.calls.map(([path]) => path)).toEqual(expect.arrayContaining(['/api/v2/items', '/api/v2/sources', '/api/v1/flows']))
  })

  it('主题按钮同步 html 属性、存储与跨标签页变化', async () => {
    renderAt('/flows')
    await screen.findByRole('heading', { level: 1 })

    await userEvent.click(screen.getByRole('button', { name: '切换到暗色主题' }))
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
    expect(screen.getByRole('button', { name: '切换到亮色主题' })).toBeInTheDocument()

    window.dispatchEvent(new StorageEvent('storage', { key: THEME_STORAGE_KEY, newValue: 'light' }))
    await waitFor(() => { expect(document.documentElement.dataset.theme).toBe('light') })
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(screen.getByRole('button', { name: '切换到暗色主题' })).toBeInTheDocument()
  })

  it('黑白主题与明暗互不影响，并同步存储与跨标签页变化', async () => {
    renderAt('/flows')
    await screen.findByRole('heading', { level: 1 })
    expect(document.documentElement.dataset.palette).toBe('color')

    await userEvent.click(screen.getByRole('button', { name: '切换到黑白主题' }))
    expect(document.documentElement.dataset.palette).toBe('mono')
    expect(window.localStorage.getItem(PALETTE_STORAGE_KEY)).toBe('mono')
    expect(screen.getByRole('button', { name: '切换到彩色主题' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '切换到暗色主题' }))
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(document.documentElement.dataset.palette).toBe('mono')
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')

    window.dispatchEvent(new StorageEvent('storage', { key: PALETTE_STORAGE_KEY, newValue: 'color' }))
    await waitFor(() => { expect(document.documentElement.dataset.palette).toBe('color') })
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(screen.getByRole('button', { name: '切换到黑白主题' })).toBeInTheDocument()
  })
})
