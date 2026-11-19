import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { setToken } from '@/shared/http/session'
import { sopRoutes } from './routes'
import type { SopVersion } from './model'

const receiptV1: SopVersion = { id: 'receipt', revision: 1, executor: 'echo', config: { title: '材料接收回执' } }
const receiptV2: SopVersion = { id: 'receipt', revision: 2, executor: 'echo', config: { title: '项目交接记录' } }
const handover: SopVersion = { id: 'handover', revision: 1, executor: 'echo', config: { title: '交接清单回执' } }

type Serve = (path: string, options: RequestInit) => Response

/** 以真实路由和共享客户端挂载 SOP 模块，只有服务端响应被替换。 */
function mount(path: string, serve: Serve) {
  setToken('demo')
  const calls: { path: string; options: RequestInit }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit = {}) => {
    const clean = String(url).replace('/api/v2', '')
    calls.push({ path: clean, options })
    return serve(clean, options)
  }))
  const router = createMemoryRouter(sopRoutes, { initialEntries: [path] })
  render(<RouterProvider router={router} />)
  return { router, calls }
}

const missing = () => Response.json({ error: '未找到' }, { status: 404 })

afterEach(() => { cleanup(); sessionStorage.clear() })

it('目录按 SOP 分组列出全部修订，显示标题与执行器', async () => {
  mount('/sops', path => path === '/sops' ? Response.json([receiptV1, receiptV2, handover]) : missing())

  expect(await screen.findByRole('link', { name: 'receipt v1' })).toHaveAttribute('href', '/sops/receipt/revisions/1')
  expect(screen.getByRole('link', { name: 'receipt v2' })).toHaveAttribute('href', '/sops/receipt/revisions/2')
  expect(screen.getByRole('heading', { name: '项目交接记录' })).toBeVisible()
  expect(screen.getByText('receipt · 共 2 个修订 · 最新 v2')).toBeVisible()
  expect(screen.getByText('handover · 共 1 个修订 · 最新 v1')).toBeVisible()
  expect(screen.getAllByText('执行器 Echo（内置回执执行器）')).toHaveLength(3)
  expect(screen.getAllByText('最新')).toHaveLength(2)
  expect(screen.getByRole('link', { name: '发布 SOP' })).toHaveAttribute('href', '/sops/new')

  await userEvent.click(screen.getByRole('link', { name: 'receipt v1' }))
  expect(await screen.findByRole('heading', { name: '材料接收回执' })).toBeVisible()
  expect(screen.getByRole('link', { name: '从此版发布新版' })).toHaveAttribute('href', '/sops/receipt/revisions/1/edit')
})

it('固定修订显示冻结配置，并可从该版预填后发布新版', async () => {
  let created: SopVersion | null = null
  let sent: unknown
  mount('/sops/receipt/revisions/1', (path, options) => {
    if (path === '/sops' && options.method === 'POST') {
      sent = JSON.parse(String(options.body))
      created = { id: 'receipt', revision: 3, executor: 'echo', config: { title: '交接记录' } }
      return Response.json(created)
    }
    if (path === '/sops') return Response.json(created ? [receiptV1, receiptV2, created] : [receiptV1, receiptV2])
    return missing()
  })

  expect(await screen.findByRole('heading', { name: '材料接收回执' })).toBeVisible()
  expect(screen.getByText(/这是已冻结的历史修订，该 SOP 最新为 v2/)).toBeVisible()
  expect(screen.getByText(/回执标题写在回执开头/)).toBeVisible()
  expect(screen.getByRole('link', { name: '历史版本' })).toHaveAttribute('href', '/sops/receipt/revisions')

  await userEvent.click(screen.getByRole('link', { name: '从此版发布新版' }))
  expect(await screen.findByLabelText('SOP 标识')).toHaveValue('receipt')
  expect(screen.getByLabelText('SOP 标识')).toHaveAttribute('readonly')
  expect(screen.getByLabelText('执行器')).toHaveValue('echo')
  expect(screen.getByLabelText('回执标题')).toHaveValue('材料接收回执')

  await userEvent.clear(screen.getByLabelText('回执标题'))
  await userEvent.type(screen.getByLabelText('回执标题'), '交接记录')
  await userEvent.click(screen.getByRole('button', { name: '发布新版' }))

  await waitFor(() => expect(sent).toEqual({ id: 'receipt', executor: 'echo', config: { title: '交接记录' } }))
  expect(await screen.findByRole('heading', { name: '交接记录' })).toBeVisible()
  expect(screen.getByText('receipt v3 · 执行器 Echo（内置回执执行器）')).toBeVisible()
})

it('发布新 SOP 校验标识与标题，失败保留输入，成功后打开服务端返回的修订', async () => {
  let accept = false
  let sent: unknown
  const created: SopVersion = { id: 'handover', revision: 4, executor: 'echo', config: { title: '项目交接记录' } }
  const { router } = mount('/sops/new', (path, options) => {
    if (path === '/sops' && options.method === 'POST') {
      sent = JSON.parse(String(options.body))
      return accept ? Response.json(created) : Response.json({ error: '标题已被占用' }, { status: 409 })
    }
    if (path === '/sops') return Response.json(accept ? [created] : [receiptV1])
    return missing()
  })

  await userEvent.click(await screen.findByRole('button', { name: '发布 SOP' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('SOP 标识只能使用')

  await userEvent.type(screen.getByLabelText('SOP 标识'), 'handover')
  await userEvent.type(screen.getByLabelText('回执标题'), '项目交接记录')
  await userEvent.click(screen.getByRole('button', { name: '发布 SOP' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('标题已被占用')
  expect(screen.getByLabelText('SOP 标识')).toHaveValue('handover')
  expect(screen.getByLabelText('回执标题')).toHaveValue('项目交接记录')

  accept = true
  await userEvent.click(screen.getByRole('button', { name: '发布 SOP' }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/sops/handover/revisions/4'))
  expect(sent).toEqual({ id: 'handover', executor: 'echo', config: { title: '项目交接记录' } })
  expect(screen.getByRole('heading', { name: '项目交接记录' })).toBeVisible()
})

it('读取失败可以重试，成功空列表显示空态和发布入口', async () => {
  let failing = true
  mount('/sops', () => failing ? Response.json({ error: '目录暂不可用' }, { status: 503 }) : Response.json([]))

  expect(await screen.findByRole('alert')).toHaveTextContent('503')
  failing = false
  await userEvent.click(screen.getByRole('button', { name: '重新加载' }))
  expect(await screen.findByText('暂无已发布 SOP')).toBeVisible()
  expect(screen.getByRole('link', { name: '发布 SOP' })).toHaveAttribute('href', '/sops/new')
})

it('修订列表从新到旧排列，只包含当前 SOP 并可从最新版发布新版', async () => {
  mount('/sops/receipt/revisions', path => path === '/sops' ? Response.json([receiptV1, receiptV2, handover]) : missing())

  expect(await screen.findByRole('heading', { name: '项目交接记录' })).toBeVisible()
  expect(screen.getByText('receipt · 共 2 个修订')).toBeVisible()
  expect(screen.getAllByRole('link', { name: /^receipt v\d+$/ }).map(link => link.textContent)).toEqual(['receipt v2', 'receipt v1'])
  expect(screen.queryByRole('link', { name: 'handover v1' })).toBeNull()
  expect(screen.getByRole('link', { name: '从最新版发布新版' })).toHaveAttribute('href', '/sops/receipt/revisions/2/edit')
})

it('打开不存在的修订显示未找到并回到修订列表', async () => {
  mount('/sops/receipt/revisions/9', path => path === '/sops' ? Response.json([receiptV1, receiptV2]) : missing())

  expect(await screen.findByText(/该标识或修订不存在/)).toBeVisible()
  expect(screen.getByRole('link', { name: '查看该 SOP 的修订' })).toHaveAttribute('href', '/sops/receipt/revisions')
})
