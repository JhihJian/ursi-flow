// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'

import { api } from '@/shared/api'
import type { Workflow } from '@/shared/api/types'
import { finishConfirmation, useFeedbackStore } from '@/shared/stores/feedback'
import RunLaunchModal from './RunLaunchModal'

const workflow: Workflow = { id: 'flow-1', name: '交付流程', description: '', nodes: [], edges: [], updatedAt: '2026-01-01' }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: Error) => void
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline })
  return { promise, resolve, reject }
}

function LaunchPage({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState(true)
  return open ? <RunLaunchModal workflow={workflow} onClose={() => { onClose(); setOpen(false) }} /> : null
}

function setup() {
  const close = vi.fn()
  const router = createMemoryRouter([
    { path: '/elsewhere', element: <div>其他页面</div> },
    { path: '/workflows', element: <LaunchPage onClose={close} /> },
    { path: '/runs/:id', element: <div>运行详情</div> },
  ], { initialEntries: ['/elsewhere?section=keep', '/workflows'], initialIndex: 1 })
  render(<RouterProvider router={router} />)
  return { router, close }
}

function submitForm() {
  fireEvent.submit(document.querySelector('#launch-run') as HTMLFormElement)
}

afterEach(() => {
  cleanup()
  finishConfirmation(false)
  useFeedbackStore.setState({ toasts: [], confirmation: null })
  vi.restoreAllMocks()
})

describe('运行弹窗异步操作生命周期', () => {
  it.each(['resolve', 'reject'] as const)('提交后浏览器后退确认离开，迟到的 %s 不跳转或通知', async (outcome) => {
    const user = userEvent.setup()
    const pending = deferred<{ id: string }>()
    const post = vi.spyOn(api, 'post').mockReturnValueOnce(pending.promise)
    const { router, close } = setup()
    await user.type(screen.getByLabelText(/任务输入/), '交付报告')
    submitForm()
    expect(post).toHaveBeenCalledWith('/runs', { workflowId: workflow.id, input: '交付报告' })
    void router.navigate(-1)
    await waitFor(() => {
      expect(useFeedbackStore.getState().confirmation?.title).toContain('未保存')
    })
    finishConfirmation(true)
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/elsewhere')
    })
    expect(router.state.location.search).toBe('?section=keep')
    expect(screen.queryByLabelText(/任务输入/)).toBeNull()
    const navigate = vi.spyOn(router, 'navigate')
    if (outcome === 'resolve') pending.resolve({ id: 'late-run' })
    else pending.reject(new Error('迟到的错误'))
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect(navigate).not.toHaveBeenCalled()
    expect(router.state.location.pathname).toBe('/elsewhere')
    expect(router.state.location.search).toBe('?section=keep')
    expect(close).not.toHaveBeenCalled()
    expect(useFeedbackStore.getState().toasts).toEqual([])
  })

  it('取消填写的确认等待期间卸载，确认后不触发关闭事件', async () => {
    const user = userEvent.setup()
    const { close } = setup()
    await user.type(screen.getByLabelText(/任务输入/), '未提交任务')
    await user.click(screen.getByRole('button', { name: '关闭' }))
    await waitFor(() => {
      expect(useFeedbackStore.getState().confirmation).not.toBeNull()
    })
    cleanup()
    finishConfirmation(true)
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect(close).not.toHaveBeenCalled()
    expect(useFeedbackStore.getState().toasts).toEqual([])
  })

  it('仍在页面时请求成功，显示反馈并跳转返回的运行', async () => {
    const user = userEvent.setup()
    const pending = deferred<{ id: string }>()
    vi.spyOn(api, 'post').mockReturnValueOnce(pending.promise)
    const { router, close } = setup()
    await user.type(screen.getByLabelText(/任务输入/), '交付报告')
    submitForm()
    pending.resolve({ id: 'created-run' })
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/runs/created-run')
    })
    expect(close).toHaveBeenCalledTimes(1)
    expect(useFeedbackStore.getState().toasts.map((toast) => toast.message)).toEqual(['运行已创建'])
  })

  it('仍在页面时请求失败，保留输入并允许重试', async () => {
    const user = userEvent.setup()
    const pending = deferred<{ id: string }>()
    vi.spyOn(api, 'post').mockReturnValueOnce(pending.promise)
    const { router, close } = setup()
    await user.type(screen.getByLabelText(/任务输入/), '交付报告')
    submitForm()
    pending.reject(new Error('创建失败'))
    expect(await screen.findByRole('alert')).toHaveTextContent('创建失败')
    expect(screen.getByLabelText(/任务输入/)).toHaveValue('交付报告')
    expect(screen.getByRole('button', { name: '开始运行' })).toBeEnabled()
    expect(router.state.location.pathname).toBe('/workflows')
    expect(close).not.toHaveBeenCalled()
    expect(useFeedbackStore.getState().toasts).toEqual([])
  })
})
