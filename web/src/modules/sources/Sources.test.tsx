import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { setToken } from '@/shared/http/session'
import { sourceRoutes } from './routes'

type Serve = (path: string, options: RequestInit) => Response

function start(path: string, serve: Serve) {
  setToken('demo-token')
  const calls: { path: string; options: RequestInit }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
    const clean = String(url).replace('/api/v2', '')
    calls.push({ path: clean, options })
    return serve(clean, options)
  }))
  const router = createMemoryRouter(sourceRoutes, { initialEntries: [path] })
  render(<RouterProvider router={router} />)
  return { router, calls }
}

afterEach(() => { cleanup(); sessionStorage.clear() })

it('来源索引只展示服务端公布的来源、类型与动作名', async () => {
  start('/sources', () => Response.json([{ id: 'tickets', kind: 'json-file', actions: ['inspect', 'escalate'] }]))
  expect(await screen.findByRole('link', { name: /tickets/ })).toHaveAttribute('href', '/sources/tickets/items')
  expect(screen.getByText('json-file · inspect、escalate')).toBeVisible()
})

it('来源未启用与已配置但为空分开呈现，未启用可重新检查', async () => {
  let configured = false
  const { calls } = start('/sources', () =>
    configured ? Response.json([]) : Response.json({ error: '来源路由未挂载' }, { status: 404 }))
  expect(await screen.findByText('外部来源未启用')).toBeVisible()
  configured = true
  await userEvent.click(screen.getByRole('button', { name: '重新检查' }))
  expect(await screen.findByText('暂无外部来源')).toBeVisible()
  expect(screen.queryByText('外部来源未启用')).toBeNull()
  expect(calls.filter(call => call.path === '/sources')).toHaveLength(2)
})

it('条目列表刷新真正重读导出，替换后显示新条目', async () => {
  let exported = [{ id: 'T-1', title: '旧标题' }]
  const { calls } = start('/sources/tickets/items', () => Response.json(exported))
  expect(await screen.findByText('旧标题')).toBeVisible()
  expect(screen.getByRole('link', { name: /旧标题/ })).toHaveAttribute('href', '/sources/tickets/items/T-1')
  exported = [{ id: 'T-1', title: '新标题' }, { id: 'T-2', title: '新增条目' }]
  await userEvent.click(screen.getByRole('button', { name: '刷新' }))
  expect(await screen.findByText('新标题')).toBeVisible()
  expect(screen.getByText('新增条目')).toBeVisible()
  expect(screen.queryByText('旧标题')).toBeNull()
  expect(calls.filter(call => call.path === '/sources/tickets/items')).toHaveLength(2)
})

it('切换来源时按新来源重新读取条目，不保留上一个来源的数据', async () => {
  const { router, calls } = start('/sources/a/items', path =>
    Response.json([{ id: 'X-1', title: path.includes('/sources/a/') ? '来源 A 条目' : '来源 B 条目' }]))
  expect(await screen.findByText('来源 A 条目')).toBeVisible()
  await act(async () => { await router.navigate('/sources/b/items') })
  expect(await screen.findByText('来源 B 条目')).toBeVisible()
  expect(screen.queryByText('来源 A 条目')).toBeNull()
  expect(calls.filter(call => call.path === '/sources/b/items')).toHaveLength(1)
})

it('空列表、来源未配置与导出不可用分别呈现，故障可重试', async () => {
  let mode: 'empty' | 'missing' | 'unavailable' = 'empty'
  const { calls } = start('/sources/tickets/items', () => {
    if (mode === 'empty') return Response.json([])
    if (mode === 'missing') return Response.json({ error: '来源不存在' }, { status: 404 })
    return Response.json({ error: '来源导出文件不可用' }, { status: 503 })
  })
  expect(await screen.findByText('当前导出没有条目')).toBeVisible()

  mode = 'missing'
  await userEvent.click(screen.getByRole('button', { name: '刷新' }))
  expect(await screen.findByText('来源未配置')).toBeVisible()
  expect(screen.queryByText('当前导出没有条目')).toBeNull()

  mode = 'unavailable'
  await userEvent.click(screen.getByRole('button', { name: '重新检查' }))
  expect(await screen.findByText('暂时无法读取来源条目')).toBeVisible()
  expect(screen.queryByText('来源未配置')).toBeNull()

  await userEvent.click(screen.getByRole('button', { name: '重新加载' }))
  expect(await screen.findByText('暂时无法读取来源条目')).toBeVisible()
  expect(calls.filter(call => call.path === '/sources/tickets/items')).toHaveLength(4)
})
