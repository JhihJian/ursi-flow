import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'
import { setToken } from '@/shared/http/session'
import { definitionRoutes } from './routes'

const prompt = { id: 'guide', revision: 1, kind: 'prompt', content: 'other' }
const skill = { ...prompt, revision: 2, kind: 'skill' }
const definition = { id: 'review', resources: [{ id: 'guide', revision: 2 }], agent: { modelProfile: 'managed', systemPrompt: '固定要求', tools: ['tickets.get'] } }
const latest = { ...definition, revision: 4, active: true }
function open(path: string) {
  const calls: { path: string; method: string; body?: unknown }[] = []
  let authorized = true
  let unavailable = false
  setToken('test-token')
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = url.replace('/api/v2', '')
    calls.push({ method: init.method ?? 'GET', path, body: init.body ? JSON.parse(String(init.body)) : undefined })
    if (path === '/agent-options') return unavailable ? Response.json({}, { status: 503 }) : Response.json({ models: [{ id: 'managed' }], tools: authorized ? [{ id: 'tickets.get' }] : [] })
    if (path === '/resources') return Response.json([{ ...skill, active: true }, { ...prompt, id: 'prompt-only', active: true }])
    if (path === '/resources/guide/revisions') return Response.json([prompt, skill])
    if (path === '/patches/work') return Response.json([{ id: 'sample', name: '核查样例', directoryId: 'private' }])
    if (path.startsWith('/executor-attempts/')) return Response.json({ attemptId: path.split('/').pop(), status: 'succeeded' })
    if (path.startsWith('/executors')) return Response.json(latest)
    return Response.json({}, { status: 404 })
  }))
  const router = createMemoryRouter(definitionRoutes, { initialEntries: [path] })
  render(<RouterProvider router={router} />)
  return { router, calls, revoke: () => { authorized = false }, outage: (down: boolean) => { unavailable = down } }
}
afterEach(() => { cleanup(); sessionStorage.clear(); setToken(''); vi.unstubAllGlobals() })

it('从新建页选择 Agent，固定 Skill 修订，以样例试跑后修改草稿并独立发布新版', async () => {
  const user = userEvent.setup()
  const { calls, router } = open('/executors/new')
  await user.click(await screen.findByRole('link', { name: '基于 Agent 配置' }))
  await user.type(await screen.findByLabelText('执行器 ID'), 'review')
  await user.type(screen.getByLabelText('固定指令'), '固定要求')
  await user.selectOptions(screen.getByLabelText('受管模型'), 'managed')
  await user.click(screen.getByRole('checkbox', { name: 'tickets.get' }))
  await user.click(screen.getByRole('button', { name: '添加Skill 资源' }))
  expect(screen.queryByRole('option', { name: 'prompt-only' })).toBeNull()
  await user.selectOptions(screen.getByLabelText('资源 ID'), 'guide')
  await screen.findByRole('option', { name: 'v2 · Skill' })
  expect(screen.queryByRole('option', { name: 'v1 · 提示词' })).toBeNull()
  await user.selectOptions(screen.getByLabelText('资源版本'), '2')
  await user.click(screen.getByText('预览执行器配置'))
  expect(screen.getByText('guide @2')).toBeVisible()
  await user.selectOptions(screen.getByLabelText('样例工作包（可选）'), 'sample')
  await user.type(screen.getByLabelText('本次指令'), '核对本周')
  await user.click(screen.getByRole('button', { name: '试跑' }))
  expect(await screen.findByText('已完成')).toBeVisible()
  expect(calls.filter(c => c.method === 'PUT')).toEqual([{ method: 'PUT', path: expect.stringMatching(/^\/executor-attempts\/[a-f0-9-]{36}$/), body: {
    previewDefinition: definition, workPatchId: 'sample', workInstruction: { encoding: 'utf-8', text: '核对本周' },
  } }])
  expect(calls.some(c => c.method === 'POST')).toBe(false)
  await user.type(screen.getByLabelText('固定指令'), '。')
  expect(screen.getByText('旧配置的试跑结果')).toBeVisible()
  await user.click(screen.getByRole('button', { name: '发布执行器' }))
  expect(calls.filter(c => c.method === 'POST')).toEqual([{ method: 'POST', path: '/executors', body: { ...definition, agent: { ...definition.agent, systemPrompt: '固定要求。' } } }])
  await waitFor(() => expect(router.state.location.pathname).toBe('/executors/review/revisions/4'))
})

it('编辑 Agent 历史修订，选项故障或草稿中的工具已被撤销时均不能提交', async () => {
  const user = userEvent.setup()
  const { router, revoke, outage } = open('/executors/review/revisions/4/edit')
  expect(await screen.findByLabelText('执行器 ID')).toHaveAttribute('readonly')
  expect(screen.getByLabelText('固定指令')).toHaveValue('固定要求')
  await user.type(screen.getByLabelText('固定指令'), ' 草稿')
  await act(() => router.navigate('/executors'))
  revoke(); outage(true)
  await act(() => router.navigate('/executors/review/revisions/4/edit'))
  await screen.findByText(/已恢复上次/)
  expect(screen.getByLabelText('固定指令')).toHaveValue('固定要求 草稿')
  expect(screen.getByRole('button', { name: '发布新版' })).toBeDisabled()
  outage(false)
  await user.click(await screen.findByRole('button', { name: '重试读取选项' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('工具已不可用：tickets.get')
  expect(screen.getByRole('button', { name: '发布新版' })).toBeDisabled()
  await user.click(screen.getByRole('button', { name: '移除不可用工具' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '发布新版' })).toBeEnabled())
})
