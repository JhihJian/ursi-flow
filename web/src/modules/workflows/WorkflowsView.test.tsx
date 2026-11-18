// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'

import { api } from '@/shared/api'
import type { Role, Workflow } from '@/shared/api/types'
import { finishConfirmation, useFeedbackStore } from '@/shared/stores/feedback'
import WorkflowsView from './WorkflowsView'

const flow: Workflow = {
  id: 'flow-1',
  name: '交付流程',
  description: '从需求到交付',
  nodes: [{ id: 'agent', name: '分析', type: 'agent', roleId: 'author' }],
  edges: [],
  updatedAt: '2026-01-01T00:00:00Z',
}
const roles = [{ id: 'author', name: '分析师' }] as Role[]

beforeEach(() => {
  vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/roles') return roles
    if (path === '/workflows') return [flow]
    return flow
  })
})

afterEach(() => {
  cleanup()
  finishConfirmation(false)
  useFeedbackStore.setState({ toasts: [], confirmation: null })
  vi.restoreAllMocks()
})

function setup() {
  const router = createMemoryRouter([
    { path: '/workflows', element: <WorkflowsView /> },
    { path: '/runs/:id', element: <div>运行详情</div> },
  ], { initialEntries: ['/workflows'] })
  render(<RouterProvider router={router} />)
  return router
}

describe('工作流界面闭环', () => {
  it('搜索与名称详情展示接口返回的流程图', async () => {
    const user = userEvent.setup()
    setup()
    const search = await screen.findByRole('searchbox', { name: '搜索工作流' })
    await user.type(search, '不存在')
    expect(await screen.findByRole('heading', { name: '没有匹配的工作流' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '清除搜索' }))
    await user.click(await screen.findByRole('button', { name: '交付流程' }))
    expect(await screen.findByRole('dialog', { name: '交付流程' })).toBeInTheDocument()
    await waitFor(() => {
      expect(api.get).toHaveBeenCalledWith('/workflows/flow-1', expect.any(AbortSignal))
    })
    await user.click(await screen.findByRole('button', { name: /分析.*智能体/ }))
    expect(screen.getByText(/角色：分析师/)).toBeInTheDocument()
  })

  it('新建校验必填，保存失败保留草稿并保护离开', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'post').mockRejectedValue(new Error('保存失败'))
    setup()
    await user.click(await screen.findByRole('button', { name: '新建工作流' }))
    expect(await screen.findByRole('dialog', { name: '新建工作流' })).toBeInTheDocument()
    await screen.findByRole('option', { name: /分析师/ })
    fireEvent.submit(document.querySelector('#workflow-editor') as HTMLFormElement)
    expect(screen.getAllByText('请填写工作流名称。').length).toBeGreaterThan(0)
    const nameInput = screen.getByLabelText(/名称/)
    await user.type(nameInput, '新工作流')
    await user.click(screen.getByRole('button', { name: '添加节点' }))
    fireEvent.submit(document.querySelector('#workflow-editor') as HTMLFormElement)
    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith('/workflows', expect.objectContaining({
        name: '新工作流',
        nodes: [expect.objectContaining({ roleId: 'author', type: 'agent' })],
      }))
    })
    expect(await screen.findByText('保存失败')).toBeInTheDocument()
    expect(screen.getByLabelText(/名称/)).toHaveValue('新工作流')
    await user.click(screen.getByRole('button', { name: '取消' }))
    await waitFor(() => {
      expect(useFeedbackStore.getState().confirmation?.title).toContain('未保存')
    })
    finishConfirmation(false)
    await waitFor(() => {
      expect(useFeedbackStore.getState().confirmation).toBeNull()
    })
    expect(document.querySelector('#workflow-editor')).not.toBeNull()
  })

  it('发起运行前验证任务，成功后按响应标识跳转详情', async () => {
    const user = userEvent.setup()
    const post = vi.spyOn(api, 'post').mockResolvedValue({ id: 'created-run' })
    const router = setup()
    await user.click(await screen.findByRole('button', { name: /^运行$/ }))
    expect(await screen.findByRole('dialog', { name: '运行工作流' })).toBeInTheDocument()
    fireEvent.submit(document.querySelector('#launch-run') as HTMLFormElement)
    expect(post).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('请填写任务输入')
    await user.type(screen.getByLabelText(/任务输入/), '请分析任务并交付报告')
    fireEvent.submit(document.querySelector('#launch-run') as HTMLFormElement)
    await waitFor(() => {
      expect(post).toHaveBeenCalledWith('/runs', { workflowId: 'flow-1', input: '请分析任务并交付报告' })
    })
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/runs/created-run')
    })
  })
})
