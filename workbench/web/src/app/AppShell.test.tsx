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
    expect(screen.getByRole('link', { name: 'ursi-flow 首页' })).toHaveAttribute('href', '/work-items')
    expect(screen.getByRole('link', { name: '跳到主要内容' })).toHaveAttribute('href', '#main-content')

    const mainNav = screen.getByRole('navigation', { name: '主导航' })
    for (const [name, href] of [['工作清单', '/work-items'], ['平台 MCP 服务', '/mcp-servers'], ['工作包', '/work-patches'], ['配置包', '/config-patches'], ['资源库', '/resources'], ['执行器', '/executors']]) {
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

  it('部署的专有管理页替换桌面和移动管理入口，不改变业务 API 或携带令牌', async () => {
    const meta = document.createElement('meta')
    meta.name = 'ursi-executor-management-url'
    meta.content = 'https://admin.example.org/console/'
    document.head.append(meta)
    try {
      renderAt('/flows')
      await screen.findByRole('heading', { level: 1 })
      const check = (nav: HTMLElement) => {
        expect(within(nav).getByRole('link', { name: '执行器管理平台' })).toHaveAttribute('href', meta.content)
        expect(within(nav).queryByRole('link', { name: /^执行器$/ })).toBeNull()
        expect(within(nav).getByRole('link', { name: '工作包' })).toHaveAttribute('href', '/work-patches')
      }
      check(screen.getByRole('navigation', { name: '主导航' }))
      await userEvent.click(screen.getByRole('button', { name: '打开导航菜单' }))
      check(within(await screen.findByRole('dialog')).getByRole('navigation', { name: '主导航' }))
      expect(vi.mocked(fetch).mock.calls.every(([path]) => path === '/api/v1/flows')).toBe(true)
    } finally { meta.remove() }
  })

  it('移动抽屉展示工作区导航并在导航后关闭', async () => {
    const { router } = renderAt('/flows')
    await screen.findByRole('heading', { level: 1 })

    await userEvent.click(screen.getByRole('button', { name: '打开导航菜单' }))
    const drawer = await screen.findByRole('dialog', { name: '工作区导航' })
    expect(within(drawer).getByRole('link', { name: '工作清单' })).toHaveAttribute('href', '/work-items')
    await userEvent.click(within(drawer).getByRole('link', { name: '运行配置' }))

    await waitFor(() => { expect(router.state.location.pathname).toBe('/flow-config') })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('运行配置')
  })

  it('Flow 集合 404 时收起运行工具，深链仍能返回工作清单', async () => {
    vi.stubGlobal('fetch', vi.fn(async (path: string) => Response.json([], { status: path === '/api/v1/flows' ? 404 : 200 })))
    renderAt('/runs/r1')
    expect(await screen.findByRole('heading', { name: 'Flow 工具未启用' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '返回工作清单' })).toHaveAttribute('href', '/work-items')
    const nav = within(screen.getByRole('navigation', { name: '主导航' }))
    for (const name of ['Flow 包', '运行记录', '运行配置']) expect(nav.queryByRole('link', { name })).toBeNull()
    expect(nav.getByRole('link', { name: '工作清单' })).toBeInTheDocument()
    await userEvent.click(nav.getByRole('link', { name: '工作包生成器' }))
    expect(await screen.findByRole('heading', { name: '工作包生成器' })).toBeInTheDocument()
    await userEvent.click(nav.getByRole('link', { name: '生成记录' }))
    expect(await screen.findByRole('heading', { name: '生成记录' })).toBeInTheDocument()
  })

  it('桌面侧栏与移动抽屉提供相同分组和入口', async () => {
    renderAt('/flows')
    await screen.findByRole('heading', { level: 1 })
    const entries = (nav: HTMLElement) => [...nav.querySelectorAll('a')].map(link => [link.textContent, link.getAttribute('href')])
    const [desktop] = screen.getAllByRole('navigation', { name: '主导航' })
    const desktopEntries = entries(desktop!)
    expect(desktopEntries.map(([title]) => title)).toEqual(['工作清单', '工作项目', '工作包', '生成记录', '工作包生成器', '配置包', '资源库', '执行器', 'Agent 后端', '平台 MCP 服务', '环境变量', 'Flow 包', '运行记录', '运行配置', '对话'])

    await userEvent.click(screen.getByRole('button', { name: '打开导航菜单' }))
    const drawer = await screen.findByRole('dialog', { name: '工作区导航' })
    expect(entries(within(drawer).getByRole('navigation', { name: '主导航' }))).toEqual(desktopEntries)
    for (const group of ['日常工作', '工作定义', '平台设置', '运行工具', '本地演示']) {
      expect(within(drawer).getByRole('heading', { name: group })).toBeInTheDocument()
    }
  })

  it('可选模块探测失败时仍能使用工作清单并单独重试', async () => {
    let flowCalls = 0
    const fetch = vi.fn(async (path: string) => {
      if (path === '/api/v2/work-items' || path === '/api/v2/patches/work') return Response.json([])
      if (path === '/api/v1/flows') return Response.json([], { status: ++flowCalls === 1 ? 503 : 200 })
      throw Error(`意外 API：${path}`)
    })
    vi.stubGlobal('fetch', fetch)
    renderAt('/work-items')
    expect(await screen.findByText('暂无工作项')).toBeInTheDocument()
    expect(await screen.findByText(/Flow 工具检查失败：HTTP 503/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '重试Flow 工具' }))
    await waitFor(() => { expect(screen.queryByText(/Flow 工具检查失败/)).toBeNull() })
    expect(screen.getByRole('link', { name: 'Flow 包' })).toBeInTheDocument()
    expect(screen.getByText('暂无工作项')).toBeInTheDocument()
    expect(fetch.mock.calls.map(([path]) => path)).toEqual(expect.arrayContaining(['/api/v2/work-items', '/api/v2/patches/work', '/api/v1/flows']))
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
