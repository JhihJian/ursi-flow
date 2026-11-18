import { createMemoryRouter, RouterProvider } from 'react-router'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '@/shared/api'
import type { Connection } from '@/shared/api/types'
import { finishConfirmation, useFeedbackStore } from '@/shared/stores/feedback'
import ConnectionsView from './ConnectionsView'

const connection: Connection = {
  id: 'model-1',
  name: '团队模型',
  provider: 'OpenAI',
  baseUrl: 'https://api.example.com/v1',
  model: 'gpt-4.1',
  credentialRef: 'env:OPENAI_KEY',
  updatedAt: '2026-01-01',
}

const confirmation = () => useFeedbackStore.getState().confirmation

beforeEach(() => {
  vi.spyOn(api, 'get').mockResolvedValue([{ ...connection }])
})

afterEach(() => {
  cleanup()
  finishConfirmation(false)
  useFeedbackStore.setState({ toasts: [] })
  vi.restoreAllMocks()
})

function setup() {
  const router = createMemoryRouter([{ path: '/connections', element: <ConnectionsView /> }], { initialEntries: ['/connections'] })
  render(<RouterProvider router={router} />)
  return router
}

async function openCard() {
  setup()
  expect(await screen.findByRole('heading', { name: '团队模型' })).toBeInTheDocument()
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: '编辑' }))
  const dialog = screen.getByRole('dialog', { name: '编辑模型连接' })
  return { user, dialog }
}

describe('连接配置与验证反馈', () => {
  it('编辑使用独立草稿，接口返回后更新卡片', async () => {
    vi.spyOn(api, 'put').mockResolvedValue({ ...connection, name: '新的团队模型' })
    const { user, dialog } = await openCard()
    const name = within(dialog).getByLabelText(/连接名称/)
    await user.clear(name)
    await user.type(name, '新的团队模型')
    expect(screen.getByText('团队模型', { exact: true })).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: '保存连接' }))
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/connections/model-1', expect.objectContaining({ name: '新的团队模型', credentialRef: 'env:OPENAI_KEY' })))
    expect(await screen.findByRole('heading', { name: '新的团队模型' })).toBeInTheDocument()
  })

  it('新建连接弹窗沿用字段名称，创建后的卡片提供可访问的删除按钮', async () => {
    vi.spyOn(api, 'post').mockResolvedValue({
      ...connection,
      id: 'model-2',
      name: '验收模型连接',
      provider: 'custom',
      model: 'acceptance-model-v1',
      baseUrl: 'https://models.example.com/v1',
      credentialRef: 'env:ACCEPTANCE_MODEL_TOKEN',
    })
    setup()
    expect(await screen.findByRole('heading', { name: '团队模型' })).toBeInTheDocument()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '新建连接' }))
    const dialog = screen.getByRole('dialog', { name: '新建模型连接' })
    await user.type(within(dialog).getByLabelText(/连接名称/), '验收模型连接')
    const provider = within(dialog).getByLabelText(/服务提供方/)
    await user.clear(provider)
    await user.type(provider, 'custom')
    await user.type(within(dialog).getByLabelText(/模型名称/), 'acceptance-model-v1')
    const baseUrl = within(dialog).getByLabelText(/服务地址/)
    await user.clear(baseUrl)
    await user.type(baseUrl, 'https://models.example.com/v1')
    await user.type(within(dialog).getByLabelText(/凭据引用/), 'env:ACCEPTANCE_MODEL_TOKEN')
    await user.click(within(dialog).getByRole('button', { name: '创建连接' }))

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/connections', expect.objectContaining({ name: '验收模型连接', provider: 'custom', model: 'acceptance-model-v1' })))
    const heading = await screen.findByRole('heading', { name: '验收模型连接' })
    const card = heading.closest('article')!
    expect(within(card).getByRole('button', { name: '删除 验收模型连接' })).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: '模拟验证' })).toBeInTheDocument()
  })

  it('保存失败保留草稿与错误，再关闭时确认未保存内容', async () => {
    vi.spyOn(api, 'put').mockRejectedValue(new Error('写入失败，请重试'))
    const { user, dialog } = await openCard()
    const name = within(dialog).getByLabelText(/连接名称/)
    await user.clear(name)
    await user.type(name, '待保存名称')
    await user.click(within(dialog).getByRole('button', { name: '保存连接' }))
    await waitFor(() => expect(within(dialog).getByRole('alert')).toHaveTextContent('写入失败'))
    expect(name).toHaveValue('待保存名称')

    await user.click(within(dialog).getByRole('button', { name: '取消' }))
    await waitFor(() => expect(confirmation()?.title).toContain('未保存'))
    await act(async () => { finishConfirmation(false) })
    expect(screen.getByRole('dialog', { name: '编辑模型连接' })).toBeInTheDocument()
  })

  it('模拟验证展示 API 消息和零毫秒耗时，失败后可重试', async () => {
    const post = vi.spyOn(api, 'post').mockRejectedValueOnce(new Error('验证服务不可用')).mockResolvedValueOnce({ ok: true, message: '模拟连接验证成功', latency: 0 })
    setup()
    expect(await screen.findByRole('heading', { name: '团队模型' })).toBeInTheDocument()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '模拟验证' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('验证服务不可用'))
    await user.click(screen.getByRole('button', { name: '模拟验证' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('模拟连接验证 · 通过'))
    expect(post).toHaveBeenCalledWith('/connections/model-1/test')
    expect(screen.getByRole('status')).toHaveTextContent('0 ms')
  })

  it('确认删除后呈现引用冲突并保留连接', async () => {
    vi.spyOn(api, 'delete').mockRejectedValue(new Error('连接仍被角色引用，请先调整角色。'))
    setup()
    expect(await screen.findByRole('heading', { name: '团队模型' })).toBeInTheDocument()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '删除 团队模型' }))
    await waitFor(() => expect(confirmation()?.title).toContain('团队模型'))
    await act(async () => { finishConfirmation(true) })
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('仍被角色引用'))
    expect(screen.getAllByRole('article')).toHaveLength(1)
  })
})
