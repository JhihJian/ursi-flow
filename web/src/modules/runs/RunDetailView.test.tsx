// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'

import { api } from '@/shared/api'
import type { Run } from '@/shared/api/types'
import { finishConfirmation, useFeedbackStore } from '@/shared/stores/feedback'
import RunDetailView from './RunDetailView'

let current: Run

function stubRun() {
  current = {
    id: 'run-1', name: '报告交付', workflowId: 'flow-1', workflowName: '报告流程', status: 'waiting', attempt: 1,
    input: '请准备年度报告', sandboxId: 'sandbox-1', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:02Z',
    nodes: [
      { id: 'draft', name: '起草', type: 'script', status: 'succeeded', output: '报告草稿已生成' },
      { id: 'parallel', name: '独立支路', type: 'script', status: 'succeeded' },
      { id: 'review', name: '审阅', type: 'approval', status: 'waiting_approval' },
    ],
    events: [{ id: 'event-1', at: '2026-01-01T00:00:01Z', nodeId: 'draft', type: 'log', message: '已保存草稿' }],
    snapshot: {
      workflow: {
        id: 'flow-1', name: '冻结的报告流程', description: '创建时配置',
        nodes: [{ id: 'draft', name: '起草', type: 'script', script: 'echo report' }, { id: 'review', name: '审阅', type: 'approval' }],
        edges: [{ source: 'draft', target: 'review' }], updatedAt: '',
      },
      roles: [], connections: [],
    },
  }
}

function renderAt(path: string) {
  const router = createMemoryRouter([
    { path: '/runs/:id', Component: RunDetailView },
    { path: '/runs', element: <div>运行记录</div> },
    { path: '/artifacts', element: <div>产物管理</div> },
    { path: '/sandboxes', element: <div>沙箱管理</div> },
  ], { initialEntries: [path] })
  return { router, ...render(<RouterProvider router={router} />) }
}

async function setup() {
  const view = renderAt('/runs/run-1')
  await screen.findByRole('heading', { level: 1, name: '报告交付' })
  return view
}

beforeEach(() => {
  stubRun()
  useFeedbackStore.setState({ toasts: [], confirmation: null })
  vi.spyOn(api, 'get').mockImplementation(async (path) => (path.startsWith('/artifacts') ? [] : structuredClone(current)))
})

afterEach(() => {
  cleanup()
  finishConfirmation(false)
  useFeedbackStore.setState({ toasts: [], confirmation: null })
})

describe('运行详情审批与快照', () => {
  it('打回仅列已完成祖先，确认后提交目标并保留历史日志', async () => {
    const post = vi.spyOn(api, 'post').mockImplementation(async () => {
      current = {
        ...current,
        status: 'running',
        attempt: 2,
        nodes: current.nodes.map((node) => (node.id === 'draft'
          ? { ...node, status: 'running' as const }
          : node.id === 'review' ? { ...node, status: 'pending' as const } : node)),
      }
      return structuredClone(current)
    })
    await setup()
    await userEvent.click(screen.getByRole('button', { name: '打回返工' }))

    const dialog = await screen.findByRole('dialog', { name: '打回上游节点' })
    const options = within(dialog).getAllByRole('option').map((option) => option.textContent)
    expect(options).toContain('起草')
    expect(options).not.toContain('独立支路')
    expect(options).not.toContain('审阅')

    await userEvent.click(within(dialog).getByRole('button', { name: '确认打回' }))
    await waitFor(() => { expect(post).toHaveBeenCalledWith('/runs/run-1/reject', { targetNodeId: 'draft' }) })
    expect(await screen.findByText(/第 2 次执行/)).toBeInTheDocument()
    expect(screen.getByRole('list', { name: '运行事件日志' })).toHaveTextContent('已保存草稿')
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: '打回上游节点' })).toBeNull() })
  })

  it('403 审批失败展示权限错误并保持等待状态', async () => {
    vi.spyOn(api, 'post').mockRejectedValue(Object.assign(new Error('请求失败'), { status: 403 }))
    await setup()
    await userEvent.click(screen.getByRole('button', { name: '通过审批' }))
    expect(await screen.findByText(/403：当前账号没有执行此操作的权限/)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '等待人工审批' })).toBeInTheDocument()
  })

  it('查看任务和冻结流程，取消需确认并以服务终态为准', async () => {
    const post = vi.spyOn(api, 'post').mockImplementation(async () => {
      current = { ...current, status: 'cancelled' }
      return structuredClone(current)
    })
    await setup()
    await userEvent.click(screen.getByRole('tab', { name: '任务输入' }))
    expect(screen.getByText('请准备年度报告')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: '配置快照' }))
    expect(screen.getByText('冻结的报告流程')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '取消运行' }))
    expect(post).not.toHaveBeenCalled()
    expect(useFeedbackStore.getState().confirmation?.title).toContain('取消这次运行')
    finishConfirmation(true)
    await waitFor(() => { expect(post).toHaveBeenCalledWith('/runs/run-1/cancel', {}) })
    expect(await screen.findByText('运行已结束')).toBeInTheDocument()
  })
})
