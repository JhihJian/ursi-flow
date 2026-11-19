import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { createAppRoutes } from './router'
import { readToken, setToken } from '@/shared/http/session'

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
  render(<RouterProvider router={createMemoryRouter(createAppRoutes(), { initialEntries: ['/unknown'] })} />)
  expect(screen.getByRole('link', { name: '返回工作清单' })).toHaveAttribute('href', '/items')
  expect(fetch).not.toHaveBeenCalled()
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
