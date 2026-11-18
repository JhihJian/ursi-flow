import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { createAppRoutes } from './router'
import { readToken } from '@/shared/http/session'

afterEach(() => { cleanup(); sessionStorage.clear() })
it('在深链登录，退出后隐藏运行数据', async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json(['sample']))
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
