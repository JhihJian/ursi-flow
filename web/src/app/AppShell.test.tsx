// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'

import { createMockBackend } from '@/mocks/backend'
import { setApiTransport } from '@/shared/http/client'
import { useFeedbackStore } from '@/shared/stores/feedback'
import { createAppRoutes } from './router'
import { initTheme, PALETTE_STORAGE_KEY, THEME_STORAGE_KEY, useThemeStore } from './theme'

function renderAt(path: string) {
  const router = createMemoryRouter(createAppRoutes(), { initialEntries: [path] })
  return { router, ...render(<RouterProvider router={router} />) }
}

beforeAll(() => { initTheme() })
beforeEach(() => {
  setApiTransport(createMockBackend(undefined, { delay: 0 }).fetch)
  window.localStorage.clear()
  useFeedbackStore.setState({ toasts: [], confirmation: null })
  useThemeStore.getState().setMode('light')
  useThemeStore.getState().setPalette('color')
})
afterEach(() => {
  cleanup()
  setApiTransport((...args) => globalThis.fetch(...args))
})

describe('应用壳', () => {
  it('侧边导航切换页面并更新标题、面包屑与当前项', async () => {
    const { router } = renderAt('/workflows')
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('工作流')
    expect(screen.getByText('演示工作区')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '跳到主要内容' })).toHaveAttribute('href', '#main-content')

    const mainNav = screen.getByRole('navigation', { name: '主导航' })
    expect(within(mainNav).getByRole('link', { current: 'page' })).toHaveTextContent('工作流')

    await userEvent.click(within(mainNav).getByRole('link', { name: '运行记录' }))
    await waitFor(() => { expect(router.state.location.pathname).toBe('/runs') })
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('运行记录')
    await waitFor(() => { expect(document.title).toBe('运行记录 · ursi-flow') })
    expect(within(screen.getByRole('navigation', { name: '主导航' })).getByRole('link', { current: 'page' })).toHaveAttribute('href', '/runs')
    expect(within(screen.getByRole('navigation', { name: '面包屑' })).getByText('运行记录')).toHaveAttribute('aria-current', 'page')

    await userEvent.click(within(screen.getByRole('navigation', { name: '主导航' })).getByRole('link', { name: '对话' }))
    await waitFor(() => { expect(router.state.location.pathname).toBe('/chat') })
    await waitFor(() => { expect(document.title).toBe('对话 · ursi-flow') })
  })

  it('移动抽屉展示工作区导航并在导航后关闭', async () => {
    const { router } = renderAt('/workflows')
    await screen.findByRole('heading', { level: 1 })

    await userEvent.click(screen.getByRole('button', { name: '打开导航菜单' }))
    const drawer = await screen.findByRole('dialog', { name: '工作区导航' })
    await userEvent.click(within(drawer).getByRole('link', { name: '沙箱管理' }))

    await waitFor(() => { expect(router.state.location.pathname).toBe('/sandboxes') })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('沙箱管理')
  })

  it('主题按钮同步 html 属性、存储与跨标签页变化', async () => {
    renderAt('/roles')
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
    renderAt('/roles')
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
