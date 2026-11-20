import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { createAppRoutes } from './router'
import { readToken, setToken } from '@/shared/http/session'

const workItem = {
  id: 'item-1', package: 'example', revision: 1, assignee: 'Lin', status: 'review',
  input: {}, source: { type: 'builtin' },
  packageSnapshot: { sop: '检查日志', acceptance: '报告覆盖结论', deliverables: ['report.txt'], actions: {} },
  attempts: [], deliveries: [{ version: 2, files: { 'report.txt': 'x' }, attemptIds: [], review: null }],
  acceptedVersion: null,
}

const probe = async (path: string) => path === '/api/v2/sources' || path === '/api/v1/flows' ? Response.json([]) : Response.json({ status: 404 })

afterEach(() => { cleanup(); sessionStorage.clear() })
it('在深链登录，退出后隐藏运行数据', async () => {
  const fetch = vi.fn(async (path: string) => Response.json(path === '/api/v1/flows' ? ['sample'] : []))
  vi.stubGlobal('fetch', fetch)
  const router = createMemoryRouter(createAppRoutes(), { initialEntries: ['/flows'] })
  render(<RouterProvider router={router} />)
  await userEvent.type(await screen.findByLabelText('访问令牌'), 'manual-token')
  expect(fetch).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: '登录' }))
  expect(await screen.findByRole('link', { name: 'sample' })).toHaveAttribute('href', '/flows/sample/edit')
  expect(router.state.location.pathname).toBe('/flows')
  await userEvent.click(screen.getByRole('button', { name: '退出登录' }))
  expect(readToken()).toBe('')
  expect(await screen.findByLabelText('访问令牌')).toBeInTheDocument()
  expect(screen.queryByText('sample')).toBeNull()
})

it('根地址和未知页均可到达工作清单', async () => {
  vi.stubGlobal('fetch', vi.fn())
  const router = createMemoryRouter(createAppRoutes(), { initialEntries: ['/'] })
  render(<RouterProvider router={router} />)
  await screen.findByLabelText('访问令牌')
  expect(router.state.location.pathname).toBe('/items')
  cleanup()
  const unknown = createMemoryRouter(createAppRoutes(), { initialEntries: ['/unknown'] })
  render(<RouterProvider router={unknown} />)
  expect(screen.getByRole('heading', { name: '页面未找到' })).toBeInTheDocument()
  await userEvent.click(screen.getByRole('link', { name: '返回工作清单' }))
  await waitFor(() => expect(unknown.state.location.pathname).toBe('/items'))
  expect(await screen.findByLabelText('访问令牌')).toBeInTheDocument()
  expect(fetch).not.toHaveBeenCalled()
})

it.each([
  '/workspaces', '/workspaces/new', '/workspaces/w1/result',
  '/sops', '/sops/demo/revisions/1',
  '/templates', '/templates/triage/revisions/1/edit', '/packages', '/packages/new',
])('已移除的地址显示未找到：%s', async path => {
  setToken('test-token')
  const fetch = vi.fn(probe)
  vi.stubGlobal('fetch', fetch)
  const router = createMemoryRouter(createAppRoutes(), { initialEntries: [path] })
  render(<RouterProvider router={router} />)
  expect(await screen.findByRole('heading', { name: '页面未找到' })).toBeInTheDocument()
  expect(screen.getByRole('link', { name: '返回工作清单' })).toHaveAttribute('href', '/items')
  expect(fetch.mock.calls.map(([url]) => url).sort()).toEqual(['/api/v1/flows', '/api/v2/sources'])
})

it.each(['/items/abc', '/items/abc/deliveries/2'])('办理和交付深链在原位置登录：%s', async path => {
  vi.stubGlobal('fetch', vi.fn())
  const router = createMemoryRouter(createAppRoutes(), { initialEntries: [`${path}?status=review#report`] })
  render(<RouterProvider router={router} />)
  expect(await screen.findByLabelText('访问令牌')).toBeInTheDocument()
  expect(router.state.location).toMatchObject({ pathname: path, search: '?status=review', hash: '#report' })
  expect(fetch).not.toHaveBeenCalled()
})

it('可选集合 401 清除会话，重新登录后在原深链继续', async () => {
  setToken('expired')
  vi.stubGlobal('fetch', vi.fn(async (path: string) => (
    path === '/api/v2/sources' && readToken() === 'expired'
      ? Response.json({}, { status: 401 }) : Response.json([])
  )))
  const router = createMemoryRouter(createAppRoutes(), { initialEntries: ['/runs?filter=all'] })
  render(<RouterProvider router={router} />)
  const field = await screen.findByLabelText('访问令牌')
  expect(screen.getByRole('alert')).toHaveTextContent('令牌无效或已过期')
  await userEvent.type(field, 'new-token')
  await userEvent.click(screen.getByRole('button', { name: '登录' }))
  await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('运行记录'))
  expect(router.state.location).toMatchObject({ pathname: '/runs', search: '?filter=all' })
})

it('指定交付版本深链登录后读到那一版正文', async () => {
  const fetch = vi.fn(async (path: string) => {
    if (path === '/api/v2/items/item-1') return Response.json(workItem)
    if (path === '/api/v2/items/item-1/deliveries/2/files/report.txt') {
      return new Response('第二版报告\n第二行\n', { headers: { 'content-type': 'text/plain; charset=utf-8' } })
    }
    return probe(path)
  })
  vi.stubGlobal('fetch', fetch)
  const target = '/items/item-1/deliveries/2?status=review#report'
  const router = createMemoryRouter(createAppRoutes(), { initialEntries: [target] })
  render(<RouterProvider router={router} />)
  expect(await screen.findByLabelText('访问令牌')).toBeInTheDocument()
  await userEvent.type(screen.getByLabelText('访问令牌'), 'manual-token')
  await userEvent.click(screen.getByRole('button', { name: '登录' }))
  expect(await screen.findByRole('heading', { name: '第 2 版交付文件' })).toBeInTheDocument()
  expect(await screen.findByText(/第二版报告/)).toBeInTheDocument()
  expect(router.state.location).toMatchObject({ pathname: '/items/item-1/deliveries/2', search: '?status=review', hash: '#report' })
})

it('旧会话迟到的 401 不影响新登录', async () => {
  setToken('old-token')
  let release: (response: Response) => void = () => {}
  const late = new Promise<Response>((resolve) => { release = resolve })
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit) => {
    const authorization = new Headers(init.headers).get('Authorization')
    if (authorization === 'Bearer old-token' && (path === '/api/v2/sources' || path === '/api/v1/flows')) return late
    return Response.json([])
  }))
  render(<RouterProvider router={createMemoryRouter(createAppRoutes(), { initialEntries: ['/items'] })} />)
  expect(await screen.findByText('暂无工作项')).toBeInTheDocument()
  await act(async () => { setToken('new-token') })
  release(Response.json({}, { status: 401 }))
  await waitFor(() => expect(readToken()).toBe('new-token'))
  expect(screen.queryByLabelText('访问令牌')).toBeNull()
  expect(await screen.findByText('暂无工作项')).toBeInTheDocument()
})

it('退出后不沿用旧探测结果，重新登录会重新探测可选模块', async () => {
  let sources = 404
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === '/api/v2/sources') return Response.json([], { status: sources })
    return probe(path)
  }))
  render(<RouterProvider router={createMemoryRouter(createAppRoutes(), { initialEntries: ['/items'] })} />)
  await userEvent.type(await screen.findByLabelText('访问令牌'), 'first')
  await userEvent.click(screen.getByRole('button', { name: '登录' }))
  const nav = () => within(screen.getByRole('navigation', { name: '主导航' }))
  await waitFor(() => expect(nav().queryByRole('link', { name: '外部来源' })).toBeNull())
  await userEvent.click(screen.getByRole('button', { name: '退出登录' }))
  await screen.findByLabelText('访问令牌')
  sources = 200
  await userEvent.type(screen.getByLabelText('访问令牌'), 'second')
  await userEvent.click(screen.getByRole('button', { name: '登录' }))
  await waitFor(() => expect(nav().getByRole('link', { name: '外部来源' })).toBeInTheDocument())
})
