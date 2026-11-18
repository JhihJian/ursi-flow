// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'

import { api } from '@/shared/api'
import type { Sandbox } from '@/shared/api/types'
import { useFeedbackStore } from '@/shared/stores/feedback'
import SandboxesView from './SandboxesView'

const seed: Sandbox[] = [
  { id: 'sandbox-1', name: '交付工作区 01', runId: 'run-1', status: 'running', image: 'ursi/agent-workspace:demo', createdAt: '2026-01-01T08:00:00.000Z', cpu: '2 vCPU', memory: '4 GiB', workspace: '/workspace', logs: ['模拟工作区已准备。', '配置快照已加载。', '工作区待命，等待后续任务。'] },
  { id: 'sandbox-2', name: '交付工作区 02', runId: 'run-2', status: 'released', image: 'ursi/agent-workspace:demo', createdAt: '2026-01-01T09:00:00.000Z', cpu: '2 vCPU', memory: '4 GiB', workspace: '/workspace', logs: ['模拟工作区已准备。', '运行完成，模拟资源已释放。'] },
  { id: 'sandbox-3', name: '交付工作区 03', runId: 'run-3', status: 'failed', image: 'ursi/agent-workspace:demo', createdAt: '2026-01-01T10:00:00.000Z', cpu: '4 vCPU', memory: '8 GiB', workspace: '/workspace', logs: ['模拟工作区已准备。', '准备阶段失败。'] },
]

let list: Sandbox[] = []

function renderView(entry = '/sandboxes') {
  const router = createMemoryRouter([{ path: '/sandboxes', element: <SandboxesView /> }], { initialEntries: [entry] })
  render(<RouterProvider router={router} />)
  return router
}

function card(name: string): HTMLElement {
  const heading = screen.getByRole('button', { name })
  const article = heading.closest('article')
  if (!article) throw new Error(`未找到 ${name} 的沙箱卡片`)
  return article
}

function metric(label: string): HTMLElement {
  // 指标卡的数值带 tabular-nums，与筛选下拉里的同名选项区分开。
  const panels = Array.from(document.querySelectorAll<HTMLElement>('.panel'))
  const panel = panels.find((item) => item.querySelector('.tabular-nums') && within(item).queryByText(label, { exact: true }))
  if (!panel) throw new Error(`未找到 ${label} 指标卡`)
  return panel
}

beforeEach(() => {
  list = seed.map((item) => ({ ...item, logs: [...item.logs] }))
  vi.spyOn(api, 'get').mockImplementation(((path: string) => Promise.resolve(path === '/sandboxes' ? list : [])) as typeof api.get)
  vi.spyOn(api, 'post').mockImplementation((() => Promise.resolve({})) as typeof api.post)
})

afterEach(() => {
  cleanup()
  useFeedbackStore.setState({ toasts: [], confirmation: null })
})

describe('沙箱目录与筛选', () => {
  it('统计卡、搜索与状态筛选收敛匹配资源', async () => {
    const user = userEvent.setup()
    renderView()

    await screen.findByRole('button', { name: '交付工作区 01' })
    expect(metric('全部环境')).toHaveTextContent('3')
    expect(metric('使用中')).toHaveTextContent('1')
    expect(metric('已释放')).toHaveTextContent('1')

    await user.type(screen.getByLabelText('搜索沙箱'), 'sandbox-3')

    expect(screen.getByRole('button', { name: '交付工作区 03' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '交付工作区 01' })).not.toBeInTheDocument()

    await user.clear(screen.getByLabelText('搜索沙箱'))
    await user.selectOptions(screen.getByLabelText('沙箱状态'), 'released')

    expect(screen.getByRole('button', { name: '交付工作区 02' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '交付工作区 01' })).not.toBeInTheDocument()
  })

  it('无匹配结果展示空态，查询失败展示可重试错误', async () => {
    const user = userEvent.setup()
    renderView()
    await screen.findByRole('button', { name: '交付工作区 01' })

    await user.type(screen.getByLabelText('搜索沙箱'), '不存在的沙箱')
    expect(await screen.findByText('没有找到沙箱')).toBeInTheDocument()

    vi.restoreAllMocks()
    vi.spyOn(api, 'get').mockImplementation((() => Promise.reject(new Error('沙箱服务不可用'))) as typeof api.get)
    await user.click(screen.getByRole('button', { name: '刷新状态' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('沙箱服务不可用')
  })

  it('查看关联运行进入运行详情', async () => {
    renderView()
    await screen.findByRole('button', { name: '交付工作区 01' })

    expect(within(card('交付工作区 01')).getByRole('link', { name: /查看关联运行/ })).toHaveAttribute('href', '/runs/run-1')
  })
})

describe('资源详情与生命周期日志', () => {
  it('携带 ?id= 进入时直接打开对应详情，关闭后回到目录', async () => {
    const user = userEvent.setup()
    renderView('/sandboxes?id=sandbox-2')

    const dialog = await screen.findByRole('dialog', { name: '交付工作区 02' })
    expect(dialog).toHaveTextContent('sandbox-2')
    expect(dialog).toHaveTextContent('已释放')
    expect(dialog).toHaveTextContent('运行完成，模拟资源已释放。')

    await user.click(within(dialog).getAllByRole('button', { name: '关闭' }).at(-1)!)

    await waitFor(() => { expect(screen.queryByRole('dialog')).not.toBeInTheDocument() })
  })

  it('详情与日志按钮打开所选资源，已释放资源不提供释放按钮', async () => {
    const user = userEvent.setup()
    renderView()
    await screen.findByRole('button', { name: '交付工作区 01' })

    expect(within(card('交付工作区 01')).getByRole('button', { name: '释放' })).toBeInTheDocument()
    expect(within(card('交付工作区 02')).queryByRole('button', { name: '释放' })).not.toBeInTheDocument()

    await user.click(within(card('交付工作区 01')).getByRole('button', { name: '详情与日志' }))

    const dialog = await screen.findByRole('dialog', { name: '交付工作区 01' })
    expect(dialog).toHaveTextContent('配置快照已加载。')
  })
})

describe('确认释放与状态反馈', () => {
  it('确认后调用释放接口并刷新目录', async () => {
    const user = userEvent.setup()
    renderView()
    await screen.findByRole('button', { name: '交付工作区 01' })

    vi.mocked(api.post).mockImplementation((() => {
      list = list.map((item) => (item.id === 'sandbox-1' ? { ...item, status: 'released' as const, logs: [...item.logs, '模拟资源已释放。'] } : item))
      return Promise.resolve({})
    }) as typeof api.post)

    await user.click(within(card('交付工作区 01')).getByRole('button', { name: '释放' }))

    const confirmation = useFeedbackStore.getState().confirmation
    expect(confirmation?.title).toBe('释放沙箱？')
    expect(confirmation?.confirmLabel).toBe('释放沙箱')
    expect(confirmation?.danger).toBe(true)

    useFeedbackStore.getState().finishConfirmation(true)

    await waitFor(() => { expect(api.post).toHaveBeenCalledWith('/sandboxes/sandbox-1/release') })
    await waitFor(() => { expect(within(card('交付工作区 01')).queryByRole('button', { name: '释放' })).not.toBeInTheDocument() })
    expect(useFeedbackStore.getState().toasts.at(-1)?.message).toBe('沙箱已释放')
  })

  it('取消确认不发起请求', async () => {
    const user = userEvent.setup()
    renderView()
    await screen.findByRole('button', { name: '交付工作区 01' })

    await user.click(within(card('交付工作区 01')).getByRole('button', { name: '释放' }))
    useFeedbackStore.getState().finishConfirmation(false)

    await waitFor(() => { expect(useFeedbackStore.getState().confirmation).toBeNull() })
    expect(api.post).not.toHaveBeenCalled()
  })

  it('活动运行拒绝释放时展示后端错误并恢复操作', async () => {
    const user = userEvent.setup()
    renderView()
    await screen.findByRole('button', { name: '交付工作区 01' })
    vi.mocked(api.post).mockImplementation((() => Promise.reject(new Error('当前状态不允许此操作，请刷新后重试。'))) as typeof api.post)

    await user.click(within(card('交付工作区 01')).getByRole('button', { name: '释放' }))
    useFeedbackStore.getState().finishConfirmation(true)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('当前状态不允许此操作，请刷新后重试。')
    expect(within(card('交付工作区 01')).getByRole('button', { name: '释放' })).toBeEnabled()
    expect(within(card('交付工作区 01')).getByText('运行中')).toBeInTheDocument()
  })
})
