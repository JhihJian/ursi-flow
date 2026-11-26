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
    const { router } = renderAt('/work-items')
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('工作清单')
    expect(screen.getByRole('link', { name: 'ursi-flow 首页' })).toHaveAttribute('href', '/work-items')
    expect(screen.getByRole('link', { name: '跳到主要内容' })).toHaveAttribute('href', '#main-content')

    const mainNav = screen.getByRole('navigation', { name: '主导航' })
    for (const [name, href] of [['工作', '/work-items'], ['平台 MCP 服务', '/mcp-servers'], ['工作包', '/work-patches'], ['配置包', '/config-patches'], ['资源库', '/resources'], ['执行器', '/executors']]) {
      expect(within(mainNav).getByRole('link', { name })).toHaveAttribute('href', href)
    }
    expect(within(mainNav).getByRole('link', { name: '工作' })).toHaveAttribute('aria-current', 'true')

    await userEvent.click(within(mainNav).getByRole('link', { name: '工作包' }))
    await waitFor(() => { expect(router.state.location.pathname).toBe('/work-patches') })
    expect(await screen.findByRole('heading', { level: 1, name: '工作包' })).toBeVisible()
    await waitFor(() => { expect(document.title).toBe('工作包 · ursi-flow') })
    expect(within(screen.getByRole('navigation', { name: '主导航' })).getByRole('link', { name: '工作包' })).toHaveAttribute('aria-current', 'page')
    expect(within(screen.getByRole('navigation', { name: '面包屑' })).getByText('工作包')).toHaveAttribute('aria-current', 'page')

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
      renderAt('/work-items')
      await screen.findByRole('heading', { level: 1 })
      const check = (nav: HTMLElement) => {
        expect(within(nav).getByRole('link', { name: '执行器管理平台' })).toHaveAttribute('href', meta.content)
        expect(within(nav).queryByRole('link', { name: /^执行器$/ })).toBeNull()
        expect(within(nav).getByRole('link', { name: '工作包' })).toHaveAttribute('href', '/work-patches')
      }
      check(screen.getByRole('navigation', { name: '主导航' }))
      await userEvent.click(screen.getByRole('button', { name: '打开导航菜单' }))
      check(within(await screen.findByRole('dialog')).getByRole('navigation', { name: '主导航' }))
      expect(vi.mocked(fetch).mock.calls.map(([path]) => path)).not.toContain('/api/v1/flows')
    } finally { meta.remove() }
  })

  it('移动抽屉展示工作区导航并在导航后关闭', async () => {
    const { router } = renderAt('/work-items')
    await screen.findByRole('heading', { level: 1 })

    await userEvent.click(screen.getByRole('button', { name: '打开导航菜单' }))
    const drawer = await screen.findByRole('dialog', { name: '工作区导航' })
    expect(within(drawer).getByRole('link', { name: /^工作$/ })).toHaveAttribute('href', '/work-items')
    await userEvent.click(within(drawer).getByRole('link', { name: '工作包生成器' }))

    await waitFor(() => { expect(router.state.location.pathname).toBe('/work-patch-generators') })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('工作包生成器')
  })

  it('桌面侧栏与移动抽屉提供相同分组和入口', async () => {
    renderAt('/work-items')
    await screen.findByRole('heading', { level: 1 })
    const entries = (nav: HTMLElement) => [...nav.querySelectorAll('a')].map(link => [link.textContent, link.getAttribute('href')])
    const [desktop] = screen.getAllByRole('navigation', { name: '主导航' })
    const desktopEntries = entries(desktop!)
    expect(desktopEntries.map(([title]) => title)).toEqual(['工作', '工作包', '生成记录', '工作包生成器', '配置包', '资源库', '执行器', 'Agent 后端', '平台 MCP 服务', '环境变量', '对话'])

    await userEvent.click(screen.getByRole('button', { name: '打开导航菜单' }))
    const drawer = await screen.findByRole('dialog', { name: '工作区导航' })
    expect(entries(within(drawer).getByRole('navigation', { name: '主导航' }))).toEqual(desktopEntries)
    for (const group of ['日常工作', '工作定义', '平台设置', '本地演示']) {
      expect(within(drawer).getByRole('heading', { name: group })).toBeInTheDocument()
    }
  })

  it('主题按钮同步 html 属性、存储与跨标签页变化', async () => {
    renderAt('/work-items')
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
    renderAt('/work-items')
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
