import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { setToken } from '@/shared/http/session'
import { definitionRoutes } from './routes'

const exec = { id: 'pi', revision: 1, resources: [{ id: 'guide', revision: 1 }] }

function start(path: string, serve: (path: string, options: RequestInit) => Response) {
  setToken('demo'); vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => serve(url.replace('/api/v2', ''), options)))
  const router = createMemoryRouter(definitionRoutes, { initialEntries: [path] }); render(<RouterProvider router={router} />)
  return router
}
afterEach(() => { cleanup(); sessionStorage.clear() })

it('通过表单引用旧资源版本，MCP 版本不可绑定，即使同一 ID 后来变更了类型', async () => {
  const guide = { id: 'guide', revision: 1, kind: 'skill', content: '核查' }
  const mcp = { id: 'guide', revision: 2, kind: 'mcp', content: { serverRef: 'tools' } }
  let sent: unknown
  start('/executors/new', (url, opts) => {
    if (url === '/resources') return Response.json([{ ...mcp, active: true }])
    if (url === '/resources/guide/revisions') return Response.json([guide, mcp])
    if (opts.method === 'POST') sent = JSON.parse(String(opts.body))
    return Response.json({ ...exec, active: true })
  })
  await userEvent.type(await screen.findByLabelText('执行器 ID', { exact: true }), 'pi')
  await userEvent.click(screen.getByRole('button', { name: '添加执行器资源' }))
  await userEvent.selectOptions(screen.getByLabelText('资源 ID', { exact: true }), 'guide')
  expect(await screen.findByRole('option', { name: 'v2 · MCP 引用' })).toBeDisabled()
  await userEvent.selectOptions(screen.getByLabelText('资源版本', { exact: true }), '1')
  expect(screen.getByText('workspace + workInstruction → artifactDirectory')).toBeVisible()
  expect(screen.queryByRole('button', { name: '添加输入字段' })).toBeNull()
  await userEvent.click(screen.getByRole('button', { name: '发布执行器' }))
  await waitFor(() => expect(sent).toEqual({ id: 'pi', resources: [{ id: 'guide', revision: 1 }] }))
})

it('执行器目录展示通用契约与资源，详情不再把输入输出当作执行器字段', async () => {
  const executor = { id: 'assistant', revision: 2, resources: [{ id: 'guide', revision: 1 }] }
  const router = start('/executors', url => {
    if (url === '/executors') return Response.json([{ ...executor, active: true }])
    if (url === '/executors/assistant') return Response.json({ ...executor, active: true })
    if (url === '/executors/assistant/revisions/2') return Response.json(executor)
    if (url === '/executors/assistant/revisions') return Response.json([executor])
    return Response.json({ error: 'not found' }, { status: 404 })
  })
  expect(await screen.findByText('workspace + workInstruction → artifactDirectory')).toBeVisible()
  expect(screen.getByText('1 个固定资源')).toBeVisible()
  await userEvent.click(screen.getByRole('link', { name: 'assistant v2' }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/executors/assistant/revisions/2'))
  expect(await screen.findByRole('heading', { name: '执行契约' })).toBeVisible()
  expect(screen.getByText('平台记录日志')).toBeVisible()
  expect(screen.getByText('执行器记录日志')).toBeVisible()
  expect(screen.queryByText('输入声明')).toBeNull()
  expect(screen.queryByText('输出声明')).toBeNull()
})

it('资源目录区分加载失败和空态，按类型过滤并浏览历史版本', async () => {
  const prompt = { id: 'p', kind: 'prompt', content: '提示', revision: 2, active: true }
  const mcp = { id: 'tools', kind: 'mcp', content: { serverRef: 'tools' }, revision: 1, active: true }
  let fail = true
  start('/resources', url => {
    if (url === '/resources') return fail ? Response.json({ error: '暂不可用' }, { status: 503 }) : Response.json([prompt, mcp])
    if (url.endsWith('/revisions')) return Response.json([{ ...prompt, revision: 1 }, prompt])
    return Response.json(prompt)
  })
  expect(await screen.findByRole('alert')).toHaveTextContent('503'); fail = false
  await userEvent.click(screen.getByRole('button', { name: '重新加载' })); await screen.findByRole('link', { name: 'tools v1' })
  await userEvent.selectOptions(screen.getByLabelText('资源类型筛选'), 'prompt'); expect(screen.queryByText('tools v1')).toBeNull()
  await userEvent.click(screen.getByRole('link', { name: 'p v2' })); await userEvent.click(await screen.findByRole('link', { name: '历史版本' }))
  expect(await screen.findByRole('link', { name: 'p v1' })).toHaveAttribute('href', '/resources/p/revisions/1')
})
