import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { createAppRoutes } from './router'
import { readToken, setToken } from '@/shared/http/session'

const probe = async (_path: string) => Response.json({}, { status: 404 })

afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllEnvs() })
it('在深链登录，退出后隐藏数据', async () => {
  const fetch = vi.fn(async (_path: string) => Response.json([]))
  vi.stubGlobal('fetch', fetch)
  const router = createMemoryRouter(createAppRoutes(), { initialEntries: ['/work-items?status=active'] })
  render(<RouterProvider router={router} />)
  await userEvent.type(await screen.findByLabelText('访问令牌'), 'manual-token')
  expect(fetch).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: '登录' }))
  expect(await screen.findByRole('heading', { name: '工作清单' })).toBeVisible()
  expect(router.state.location.search).toBe('?status=active')
  await userEvent.click(screen.getByRole('button', { name: '退出登录' }))
  expect(readToken()).toBe('')
  expect(await screen.findByLabelText('访问令牌')).toBeInTheDocument()
  expect(screen.queryByText('暂无工作项')).toBeNull()
})

it('免登录预览在原深链展示规划页面，浏览器不发送令牌或请求其他模块', async () => {
  vi.stubEnv('MODE', 'lan-preview')
  const fetch = vi.fn(async (_path: string, _options: RequestInit) => Response.json([]))
  vi.stubGlobal('fetch', fetch)
  const router = createMemoryRouter(createAppRoutes(), { initialEntries: ['/work-items?status=active'] })
  render(<RouterProvider router={router} />)
  expect(await screen.findByRole('heading', { name: '工作清单' })).toBeVisible()
  expect(await screen.findByText('暂无工作项')).toBeVisible()
  expect(router.state.location.search).toBe('?status=active')
  expect(screen.queryByLabelText('访问令牌')).toBeNull()
  expect(screen.queryByRole('button', { name: '退出登录' })).toBeNull()
  const sidebar = within(screen.getByRole('navigation', { name: '主导航' }))
  expect(sidebar.getAllByRole('link').map(link => link.textContent)).toEqual(['工作'])
  expect(fetch.mock.calls.map(([path]) => path)).toEqual(['/api/v2/work-items'])
  await userEvent.click(within(screen.getByRole('navigation', { name: '工作视图' })).getByRole('link', { name: '项目' }))
  expect(await screen.findByRole('heading', { name: '工作项目' })).toBeVisible()
  await waitFor(() => expect(fetch.mock.calls.map(([path]) => path)).toEqual(['/api/v2/work-items', '/api/v2/work-projects']))
  expect(sidebar.getByRole('link', { name: '工作' })).toHaveAttribute('aria-current', 'true')
  for (const [, options] of fetch.mock.calls) {
    const headers = new Headers(options.headers)
    expect(headers.has('Authorization')).toBe(false)
    expect(headers.get('X-Ursi-Lan-Preview')).toBe('1')
  }
  expect(sessionStorage.length).toBe(0)
})

it('根地址和未知页均可到达工作清单', async () => {
  vi.stubGlobal('fetch', vi.fn())
  const router = createMemoryRouter(createAppRoutes(), { initialEntries: ['/'] })
  render(<RouterProvider router={router} />)
  await screen.findByLabelText('访问令牌')
  expect(router.state.location.pathname).toBe('/work-items')
  cleanup()
  const unknown = createMemoryRouter(createAppRoutes(), { initialEntries: ['/unknown'] })
  render(<RouterProvider router={unknown} />)
  expect(screen.getByRole('heading', { name: '页面未找到' })).toBeInTheDocument()
  await userEvent.click(screen.getByRole('link', { name: '返回工作清单' }))
  await waitFor(() => expect(unknown.state.location.pathname).toBe('/work-items'))
  expect(await screen.findByLabelText('访问令牌')).toBeInTheDocument()
  expect(fetch).not.toHaveBeenCalled()
})

it.each([
  '/workspaces', '/workspaces/new', '/workspaces/w1/result',
  '/sops', '/sops/demo/revisions/1',
  '/items', '/items/new', '/items/abc', '/items/abc/deliveries/2',
  '/sources', '/sources/tickets/items', '/sources/tickets/items/abc',
  '/templates', '/templates/triage/revisions/1/edit', '/packages', '/packages/new',
])('已移除的地址显示未找到：%s', async path => {
  setToken('test-token')
  const fetch = vi.fn(probe)
  vi.stubGlobal('fetch', fetch)
  const router = createMemoryRouter(createAppRoutes(), { initialEntries: [path] })
  render(<RouterProvider router={router} />)
  expect(await screen.findByRole('heading', { name: '页面未找到' })).toBeInTheDocument()
  expect(screen.getByRole('link', { name: '返回工作清单' })).toHaveAttribute('href', '/work-items')
  expect(fetch).not.toHaveBeenCalled()
})

it.each(['/work-items/abc', '/work-projects/abc/todo', '/executors/abc/revisions/2'])('工作项、项目和执行器深链在原位置登录：%s', async path => {
  vi.stubGlobal('fetch', vi.fn())
  const router = createMemoryRouter(createAppRoutes(), { initialEntries: [`${path}?status=review#report`] })
  render(<RouterProvider router={router} />)
  expect(await screen.findByLabelText('访问令牌')).toBeInTheDocument()
  expect(router.state.location).toMatchObject({ pathname: path, search: '?status=review', hash: '#report' })
  expect(fetch).not.toHaveBeenCalled()
})

it('401 清除会话，重新登录后在原深链继续', async () => {
  setToken('expired')
  vi.stubGlobal('fetch', vi.fn(async (_path: string) => (
    readToken() === 'expired' ? Response.json({}, { status: 401 }) : Response.json([])
  )))
  const router = createMemoryRouter(createAppRoutes(), { initialEntries: ['/work-items?filter=all'] })
  render(<RouterProvider router={router} />)
  const field = await screen.findByLabelText('访问令牌')
  expect(screen.getByRole('alert')).toHaveTextContent('令牌无效或已过期')
  await userEvent.type(field, 'new-token')
  await userEvent.click(screen.getByRole('button', { name: '登录' }))
  await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('工作清单'))
  expect(router.state.location).toMatchObject({ pathname: '/work-items', search: '?filter=all' })
})

it('旧会话迟到的 401 不影响新登录', async () => {
  setToken('old-token')
  let release: (response: Response) => void = () => {}
  const late = new Promise<Response>((resolve) => { release = resolve })
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit) => {
    const authorization = new Headers(init.headers).get('Authorization')
    if (authorization === 'Bearer old-token' && path === '/api/v2/work-items') return late
    return Response.json([])
  }))
  render(<RouterProvider router={createMemoryRouter(createAppRoutes(), { initialEntries: ['/work-items'] })} />)
  await screen.findByRole('heading', { name: '工作清单' })
  await act(async () => { setToken('new-token') })
  release(Response.json({}, { status: 401 }))
  await waitFor(() => expect(readToken()).toBe('new-token'))
  expect(screen.queryByLabelText('访问令牌')).toBeNull()
})
