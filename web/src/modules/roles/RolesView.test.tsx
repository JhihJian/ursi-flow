import { createMemoryRouter, RouterProvider } from 'react-router'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '@/shared/api'
import type { Connection, Role } from '@/shared/api/types'
import { finishConfirmation, useFeedbackStore } from '@/shared/stores/feedback'
import RolesView from './RolesView'

const connection: Connection = { id: 'connection-1', name: '团队研发模型', provider: 'openai', baseUrl: 'https://api.example.com', model: 'gpt-4.1', credentialRef: 'env:KEY', updatedAt: '2026-01-01' }

const role: Role = {
  id: 'role-product',
  name: '产品分析师',
  description: '把业务诉求整理为可验证的需求与交付范围。',
  icon: 'robot',
  color: '#8b5cf6',
  systemPrompt: '# 产品分析师\n输出需求与范围。',
  executor: 'claude-code',
  model: 'gpt-4.1',
  connectionId: 'connection-1',
  skills: [{ name: '需求拆解', content: '# 方法' }],
  mcpServers: [],
  updatedAt: '2026-01-02T03:04:05.000Z',
}

function clone<T>(data: T): T { return JSON.parse(JSON.stringify(data)) as T }

beforeEach(() => {
  vi.spyOn(api, 'get').mockImplementation(async (path) => {
    if (path === '/connections') return clone([connection])
    if (path === '/roles') return clone([role])
    if (path === '/roles/role-product') return clone(role)
    throw new Error('角色不存在')
  })
  vi.spyOn(api, 'put').mockImplementation(async (_path, payload) => clone(payload as Role))
})

afterEach(() => {
  cleanup()
  finishConfirmation(false)
  useFeedbackStore.setState({ toasts: [] })
  vi.restoreAllMocks()
})

function setup(path = '/roles?id=role-product') {
  const router = createMemoryRouter([{ path: '/roles', element: <RolesView /> }], { initialEntries: [path] })
  render(<RouterProvider router={router} />)
  return router
}

describe('角色工作室界面契约', () => {
  it('按深链接加载角色，标签、标签页与保存状态使用既有名称', async () => {
    const router = setup()
    const list = await screen.findByRole('complementary', { name: '角色列表' })
    expect(within(list).getByRole('button', { name: /产品分析师/ })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: '角色工作室' })).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: '产品分析师' })).toBeInTheDocument()
    expect(router.state.location.search).toBe('?id=role-product')

    expect(screen.getByRole('tab', { name: '基本信息' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Skills · 1' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'MCP · 0' })).toBeInTheDocument()
    expect(await screen.findByLabelText(/角色名称/)).toHaveValue('产品分析师')
    expect(screen.getByLabelText('角色描述')).toHaveValue('把业务诉求整理为可验证的需求与交付范围。')
    expect(screen.getByText('所有更改已保存', { exact: true })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('tab', { name: '系统提示词' }))
    expect(screen.getByLabelText('系统提示词', { exact: true })).toHaveValue(role.systemPrompt)
  })

  it('Skills 与 MCP 标签页沿用既有字段名称与操作按钮', async () => {
    setup()
    await screen.findByRole('heading', { name: '产品分析师' })
    expect(screen.getByRole('button', { name: '删除' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '复制' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('tab', { name: /Skills · 1/ }))
    expect(screen.getByLabelText('技能名称')).toHaveValue('需求拆解')
    expect(screen.getByLabelText('技能内容')).toHaveValue('# 方法')
    await userEvent.click(screen.getByRole('button', { name: '添加 Skill' }))
    expect(screen.getAllByLabelText('技能名称')).toHaveLength(2)

    await userEvent.click(screen.getByRole('tab', { name: /MCP · 0/ }))
    await userEvent.click(screen.getByRole('button', { name: '添加 MCP' }))
    expect(screen.getByLabelText('服务名称')).toBeInTheDocument()
    expect(screen.getByLabelText('传输方式')).toBeInTheDocument()
    expect(screen.getByLabelText('服务 URL')).toBeInTheDocument()
    expect(screen.getByLabelText('凭据引用（可选）')).toBeInTheDocument()
  })

  it('修改后显示未保存状态，保存成功后回到已保存状态', async () => {
    setup()
    const description = await screen.findByLabelText('角色描述')
    await userEvent.clear(description)
    await userEvent.type(description, '新的职责说明')
    expect(screen.getByText('有未保存的更改', { exact: true })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '保存角色' }))
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/roles/role-product', expect.objectContaining({ description: '新的职责说明' })))
    expect(await screen.findByText('所有更改已保存', { exact: true })).toBeInTheDocument()
  })

  it('创建角色弹窗沿用名称与提交按钮文案', async () => {
    vi.spyOn(api, 'post').mockResolvedValue({ ...role, id: 'role-new', name: '验收分析师' })
    setup()
    await screen.findByRole('heading', { name: '产品分析师' })
    await userEvent.click(screen.getAllByRole('button', { name: '创建角色' })[0]!)
    const dialog = screen.getByRole('dialog', { name: '创建角色' })
    await userEvent.type(within(dialog).getByLabelText(/角色名称/), '验收分析师')
    await userEvent.click(within(dialog).getByRole('button', { name: '创建角色' }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/roles', expect.objectContaining({ name: '验收分析师', connectionId: 'connection-1' })))
  })
})
