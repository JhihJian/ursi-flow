import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { setToken } from '@/shared/http/session'
import { definitionRoutes } from './routes'
import type { Package } from './catalog'

const pkg: Package = { id: 'triage', revision: 1, sop: '原 SOP', acceptance: '有证据', actions: { inspect: {
  executor: { id: 'pi', kind: 'agent', revision: 1 }, resources: [{ id: 'guide', revision: 2, kind: 'skill', content: '指南' }],
} } }
const exec = { ...pkg.actions.inspect.executor, resources: [{ id: 'guide', revision: 2 }] }
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
  await userEvent.selectOptions(screen.getByLabelText('执行环境'), 'sandbox')
  await userEvent.click(screen.getByRole('button', { name: '添加执行器资源' }))
  await userEvent.selectOptions(screen.getByLabelText('资源 ID', { exact: true }), 'guide')
  expect(await screen.findByRole('option', { name: 'v2 · MCP 引用' })).toBeDisabled()
  await userEvent.selectOptions(screen.getByLabelText('资源版本', { exact: true }), '1')
  expect(screen.getByText('workspace + workInstruction → artifactDirectory')).toBeVisible()
  expect(screen.queryByRole('button', { name: '添加输入字段' })).toBeNull()
  await userEvent.click(screen.getByRole('button', { name: '发布执行器' }))
  await waitFor(() => expect(sent).toEqual({ id: 'pi', kind: 'agent', environment: 'sandbox', resources: [{ id: 'guide', revision: 1 }] }))
})

it('历史包按阅读版本跳转，从目录读取启停状态并确认停用整个 ID', async () => {
  let active = true
  start('/templates/triage/revisions/1', (url, opts) => {
    if (url === '/packages/triage/deactivate') { expect(opts.method).toBe('POST'); active = false }
    return Response.json(url.endsWith('/1') ? pkg : { ...pkg, revision: 3, active })
  })
  expect(await screen.findByRole('link', { name: '发起工作' })).toHaveAttribute('href', '/items/new?package=triage&revision=1')
  expect(screen.getByRole('link', { name: 'pi v1' })).toHaveAttribute('href', '/executors/pi/revisions/1')
  expect(screen.getAllByRole('link', { name: 'guide v2' })[0]).toHaveAttribute('href', '/resources/guide/revisions/2')
  await userEvent.click(screen.getByRole('button', { name: '停用派工模板' })); expect(active).toBe(true)
  await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认停用' }))
  await screen.findByText('正在阅读 v1 · 最新 v3 · 对象已停用'); expect(screen.queryByRole('link', { name: '发起工作' })).toBeNull()
  expect(screen.getByText('原 SOP')).toBeVisible()
})

it('编辑旧包须明确核对不可还原字段，发布失败保留草稿，成功进入服务端返回的版本', async () => {
  let sent: Record<string, unknown> | null = null
  let accept = false
  const router = start('/templates/triage/revisions/1/edit', (url, opts) => {
    if (opts.method === 'POST') { sent = JSON.parse(String(opts.body)); return Response.json(accept ? { ...pkg, revision: 4 } : { error: '版本冲突' }, { status: accept ? 200 : 409 }) }
    if (url === '/executors') return Response.json([{ ...exec, active: true }])
    if (url === '/resources') return Response.json([])
    if (url === '/executors/pi/revisions/1') return Response.json(exec)
    if (url === '/executors/pi/revisions') return Response.json([exec])
    return Response.json(url === '/packages/triage' ? { ...pkg, revision: 3, active: true } : pkg)
  })
  const button = await screen.findByRole('button', { name: '发布新版' }); expect(button).toBeDisabled()
  await userEvent.type(screen.getByLabelText('办理说明'), ' 已更新')
  await screen.findByRole('option', { name: 'v1 · Agent' }); await userEvent.click(screen.getByLabelText('我已核对动作资源和输入输出声明'))
  await userEvent.click(button); expect(await screen.findByRole('alert')).toHaveTextContent('版本冲突'); expect(screen.getByLabelText('办理说明')).toHaveValue('原 SOP 已更新')
  expect(sent).toMatchObject({ actions: { inspect: { executor: { id: 'pi', revision: 1 }, resources: [] } } }); expect(sent).not.toHaveProperty('revision')
  accept = true; await userEvent.click(button); await waitFor(() => expect(router.state.location.pathname).toBe('/templates/triage/revisions/4'))
})

it('执行器目录展示通用契约与后端目标，详情不再把输入输出当作执行器字段', async () => {
  const executor = { id: 'assistant', revision: 2, kind: 'agent', environment: 'local', resources: [{ id: 'guide', revision: 1 }] }
  const router = start('/executors', url => {
    if (url === '/executors') return Response.json([{ ...executor, active: true }])
    if (url === '/executors/assistant') return Response.json({ ...executor, active: true })
    if (url === '/executors/assistant/revisions/2') return Response.json(executor)
    if (url === '/executors/assistant/revisions') return Response.json([executor])
    return Response.json({ error: 'not found' }, { status: 404 })
  })
  expect(await screen.findByText('workspace + workInstruction → artifactDirectory')).toBeVisible()
  expect(screen.getByText('本地 Pi Agent')).toBeVisible()
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
