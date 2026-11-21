import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { setToken } from '@/shared/http/session'
import type { McpSettings } from '@ursi/mcp-web'
import { mcpRoutes } from './routes'

const initial = { allowedTools: ['fixture'], githubToolsets: [], githubReadOnly: true }
const server = { id: 's', name: 'fixture', url: 'https://api.githubcopilot.com/mcp/', settings: initial }
afterEach(() => { cleanup(); setToken(''); vi.unstubAllGlobals() })
it('工具集按行启停；空选择使用默认值，保存不改变工具调用授权', async () => {
  setToken('fixture-only')
  const writes: McpSettings[] = []
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    if (url === '/api/v2/mcp-servers') return Response.json([server])
    if (url.endsWith('/inspection')) return Response.json({ resources: [] })
    expect(url).toBe('/api/v2/mcp-servers/s/settings')
    const value = JSON.parse(init.body); writes.push(value); return Response.json(value)
  }))
  render(<RouterProvider router={createMemoryRouter(mcpRoutes, { initialEntries: ['/mcp-servers/s'] })} />)
  await userEvent.click(await screen.findByRole('button', { name: '工具设置' }))
  await userEvent.type(screen.getByLabelText('筛选工具集'), 'repos')
  const toggle = () => screen.getByRole('switch', { name: '启用工具集 repos' })
  await userEvent.click(toggle()); await waitFor(() => expect(toggle()).toBeChecked())
  await userEvent.click(toggle()); await screen.findByText('使用 GitHub 默认工具集')
  expect(writes).toEqual([{ ...initial, githubToolsets: ['repos'] }, initial])
})
