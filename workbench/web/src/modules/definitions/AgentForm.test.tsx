import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'
import { setToken } from '@/shared/http/session'
import { definitionRoutes } from './routes'

const packages = [{ id: 'policy', name: '核查配置', directoryId: 'private' }, { id: 'other', name: '复查配置', directoryId: 'private2' }]
const definition = { id: 'review', agent: { configPackageId: 'policy', backendId: 'first' } }
const legacy = { id: 'review', revision: 3, active: true, resources: [{ id: 'guide', revision: 2 }], agent: { modelProfile: 'managed', systemPrompt: '固定要求', tools: ['tickets.get'] } }
const latest = { ...definition, revision: 4, active: true }
const available = { id: 'first', label: '主后端', configured: true, compatible: true, status: 'ready', capabilities: ['skills'], checkedAt: 1700000000000 }
function open(path: string, listPackages = () => Response.json(packages), backends = (_path: string): Response | Promise<Response> => Response.json([available])) {
  const calls: { path: string; method: string; body?: unknown }[] = []
  setToken('test-token')
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = url.replace('/api/v2', '')
    calls.push({ method: init.method ?? 'GET', path, body: init.body ? JSON.parse(String(init.body)) : undefined })
    if (path.startsWith('/agent-backends?configPackageId=')) return backends(path)
    if (path === '/patches/config') return listPackages()
    if (path === '/patches/work') return Response.json([{ id: 'sample', name: '核查样例', directoryId: 'inputs' }])
    if (path.startsWith('/executor-attempts/')) return Response.json({ attemptId: path.split('/').pop(), status: 'succeeded' })
    if (path.endsWith('/revisions/3')) return Response.json(legacy)
    if (path === '/executors' && !init.method) return Response.json([latest])
    if (path.startsWith('/executors')) return Response.json(latest)
    return Response.json({}, { status: 404 })
  }))
  const router = createMemoryRouter(definitionRoutes, { initialEntries: [path] })
  render(<RouterProvider router={router} />)
  return { router, calls }
}
afterEach(() => { cleanup(); sessionStorage.clear(); setToken(''); vi.unstubAllGlobals() })

it('选择配置包后匹配唯一后端，试跑和发布只发送两个公开引用', async () => {
  const user = userEvent.setup()
  const { calls, router } = open('/executors/new?mode=agent')
  await user.type(await screen.findByLabelText('执行器 ID'), 'review')
  await user.type(screen.getByLabelText('本次指令'), '核对本周')
  expect(screen.getByRole('button', { name: '启动' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '发布执行器' })).toBeDisabled()
  expect(calls.map(c => c.path).sort()).toEqual(['/patches/config', '/patches/work'])
  for (const name of ['固定指令', '受管模型', 'Skill 资源', '获准工具']) expect(screen.queryByLabelText(name)).toBeNull()
  await user.selectOptions(screen.getByLabelText('配置包'), 'policy')
  expect(screen.getByRole('link', { name: '编辑配置包' })).toHaveAttribute('href', '/config-patches/policy')
  await user.selectOptions(screen.getByLabelText('样例工作包（可选）'), 'sample')
  await user.click(screen.getByRole('button', { name: '试跑' }))
  expect(await screen.findByText('已完成')).toBeVisible()
  expect(calls.filter(c => c.method === 'PUT')).toEqual([{ method: 'PUT', path: expect.stringMatching(/^\/executor-attempts\/[a-f0-9-]{36}$/), body: {
    previewDefinition: definition, workPatchId: 'sample', workInstruction: { encoding: 'utf-8', text: '核对本周' },
  } }])
  expect(calls.some(c => c.method === 'POST')).toBe(false)
  await user.selectOptions(screen.getByLabelText('配置包'), 'other')
  expect(screen.getByText('旧配置的试跑结果')).toBeVisible()
  await user.click(screen.getByRole('button', { name: '发布执行器' }))
  expect(calls.filter(c => c.method === 'POST')).toEqual([{ method: 'POST', path: '/executors', body: { id: 'review', agent: { configPackageId: 'other', backendId: 'first' } } }])
  await waitFor(() => expect(router.state.location.pathname).toBe('/executors/review/revisions/4'))
})

it('换包忽略迟到结果，旧后端失效时不能静默替换或发布', async () => {
  const user = userEvent.setup()
  let resolve!: (value: Response) => void
  const oldPackage = new Promise<Response>(r => { resolve = r })
  const { router } = open('/executors/review/revisions/4/edit', undefined, async path => path.endsWith('policy') ? (await oldPackage).clone() : Response.json([available]))
  const other = await screen.findByRole<HTMLOptionElement>('option', { name: '复查配置' })
  await user.selectOptions(screen.getByLabelText('配置包'), other)
  await waitFor(() => expect(screen.getByLabelText('Agent 后端')).toHaveValue('first'))
  await act(async () => { resolve(Response.json([])) })
  expect(screen.getByRole('button', { name: '发布新版' })).toBeEnabled()
  await act(() => router.navigate('/executors'))
  await act(() => router.navigate('/executors/review/revisions/4/edit'))
  await screen.findByText(/已恢复上次/)
  await user.click(screen.getByRole('button', { name: '放弃草稿并重新填写' }))
  expect(await screen.findByText(/原后端 first 已不在列表中/)).toBeVisible()
  expect(screen.getByRole('link', { name: '查看 Agent 后端设置' })).toBeVisible()
  expect(screen.getByRole('button', { name: '发布新版' })).toBeDisabled()
})

it('没有包引用的历史 Agent 发布新版前必须选包，不能复制旧配置或资源', async () => {
  const user = userEvent.setup()
  const { calls } = open('/executors/review/revisions/3/edit')
  await screen.findByRole('option', { name: '核查配置' })
  expect(screen.getByLabelText('执行器 ID')).toHaveAttribute('readonly')
  expect(screen.getByLabelText('配置包')).toHaveValue('')
  expect(screen.getByRole('button', { name: '发布新版' })).toBeDisabled()
  await user.selectOptions(screen.getByLabelText('配置包'), 'policy')
  await user.click(screen.getByRole('button', { name: '发布新版' }))
  expect(calls.filter(c => c.method === 'POST').map(c => c.body)).toEqual([definition])
  expect(calls.some(c => c.path === '/agent-options' || c.path.startsWith('/resources'))).toBe(false)
})

it('编辑保留原引用，恢复草稿时包列表故障或已删除都不能沿用旧选项', async () => {
  const user = userEvent.setup()
  let response = () => Response.json(packages)
  const path = '/executors/review/revisions/4/edit'
  const { router } = open(path, () => response())
  await screen.findByRole('option', { name: '核查配置' })
  expect(screen.getByLabelText('配置包')).toHaveValue('policy')
  await user.selectOptions(screen.getByLabelText('配置包'), 'other')
  await act(() => router.navigate('/executors'))
  response = () => Response.json({}, { status: 503 })
  await act(() => router.navigate(path))
  await screen.findByText(/已恢复上次/)
  expect(screen.getByRole('button', { name: '发布新版' })).toBeDisabled()
  response = () => Response.json([])
  await user.click(await screen.findByRole('button', { name: '重读配置包' }))
  expect(await screen.findByText('原配置包已不可用，请重新选择。')).toBeVisible()
  expect(screen.getByRole('link', { name: '前往创建配置包' })).toHaveAttribute('href', '/config-patches')
  expect(screen.getByRole('button', { name: '发布新版' })).toBeDisabled()
})
