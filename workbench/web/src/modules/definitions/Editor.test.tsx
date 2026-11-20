import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { setToken } from '@/shared/http/session'
import { definitionRoutes } from './routes'
import type { Executor } from './catalog'
import { createFakeCatalog } from './fake-catalog'

function start(fake: ReturnType<typeof createFakeCatalog>, path: string) {
  setToken('demo')
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit = {}) => fake.handle(String(url).replace('/api/v2', ''), options)))
  const router = createMemoryRouter(definitionRoutes, { initialEntries: [path] })
  render(<RouterProvider router={router} />)
  return router
}
afterEach(() => { cleanup(); sessionStorage.clear() })

/** 用页面表单依次发布提示词 r1和引用它的执行器 r1。 */
async function publishChain(fake: ReturnType<typeof createFakeCatalog>) {
  const router = start(fake, '/resources/new')

  await userEvent.type(await screen.findByLabelText('资源 ID', { exact: true }), 'guide')
  await userEvent.selectOptions(screen.getByLabelText('资源类型'), 'prompt')
  await userEvent.type(screen.getByLabelText('资源内容'), '按材料逐项核查')
  await userEvent.click(screen.getByRole('button', { name: '发布资源' }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/resources/guide/revisions/1'))

  await router.navigate('/executors/new')
  await userEvent.type(await screen.findByLabelText('执行器 ID', { exact: true }), 'assistant')
  await userEvent.click(screen.getByRole('button', { name: '添加执行器资源' }))
  await userEvent.selectOptions(screen.getByLabelText('资源 ID', { exact: true }), 'guide')
  await userEvent.selectOptions(await screen.findByLabelText('资源版本', { exact: true }), '1')
  expect(screen.getByText('workspace + workInstruction → artifactDirectory')).toBeVisible()
  expect(screen.queryByRole('button', { name: '添加输入字段' })).toBeNull()
  await userEvent.click(screen.getByRole('button', { name: '发布执行器' }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/executors/assistant/revisions/1'))

  return router
}

it('发布固定资源的执行器，回读时可跳到该资源修订', async () => {
  const fake = createFakeCatalog()
  await publishChain(fake)
  expect(await screen.findByRole('link', { name: 'guide v1' })).toHaveAttribute('href', '/resources/guide/revisions/1')
  expect(fake.latest<Executor>('executors', 'assistant')).toMatchObject({ resources: [{ id: 'guide', revision: 1 }] })
})

it('执行器只发布通用契约、固定资源和 configSchema，页面不提供旧后端字段', async () => {
  const fake = createFakeCatalog()
  const router = start(fake, '/executors/new')

  await userEvent.type(await screen.findByLabelText('执行器 ID', { exact: true }), 'assistant')
  expect(screen.getByText('workspace + workInstruction → artifactDirectory')).toBeVisible()
  expect(screen.queryByLabelText('执行器类型')).toBeNull()
  expect(screen.queryByLabelText('执行环境')).toBeNull()
  expect(screen.queryByLabelText('Flow ID')).toBeNull()
  await userEvent.click(screen.getByRole('button', { name: '发布执行器' }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/executors/assistant/revisions/1'))
  expect(fake.posts('executors')[0]).toEqual({ id: 'assistant', resources: [] })

  await router.navigate('/executors/new')
  await userEvent.type(await screen.findByLabelText('执行器 ID', { exact: true }), 'configured')
  await userEvent.click(screen.getByRole('button', { name: '发布执行器' }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/executors/configured/revisions/1'))
  expect(fake.posts('executors')[1]).toEqual({ id: 'configured', resources: [] })
})
