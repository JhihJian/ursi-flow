import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { setToken } from '@/shared/http/session'
import { sourceRoutes } from './routes'

type Serve = (path: string, options: RequestInit) => Response

const detail = {
  id: 'T-1',
  title: '订单回执缺失',
  input: { ticket: 'T-1', symptom: '未收到回执' },
  actions: ['inspect', 'escalate'],
}

type Call = { path: string; options: RequestInit }

function start(path: string, serve: Serve) {
  setToken('demo-token')
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
    const clean = String(url).replace('/api/v2', '')
    calls.push({ path: clean, options })
    return serve(clean, options)
  }))
  const router = createMemoryRouter([
    ...sourceRoutes,
    { path: 'items/:id', element: <div data-testid="work-item">工作项</div> },
  ], { initialEntries: [path] })
  render(<RouterProvider router={router} />)
  return { router, calls }
}

const posts = (calls: Call[]) => calls.filter(call => call.options.method === 'POST')
const json = (call: Call) => JSON.parse(String(call.options.body)) as Record<string, unknown>

afterEach(() => { cleanup(); sessionStorage.clear() })

it('条目详情只读展示材料，动作名完全来自服务端', async () => {
  start('/sources/tickets/items/T-1', () => Response.json(detail))
  expect(await screen.findByRole('heading', { name: '订单回执缺失' })).toBeVisible()
  expect(screen.getByText(/"symptom": "未收到回执"/)).toBeVisible()
  expect(screen.getByText(/由管理员导出，只读/)).toBeVisible()
  expect(within(screen.getByLabelText('固定动作')).getAllByRole('option').map(option => option.textContent)).toEqual(['请选择动作', 'inspect', 'escalate'])
  expect(screen.getByRole('button', { name: '派工' })).toBeDisabled()
  expect(screen.queryByText(/package|revision|executor/i)).toBeNull()
})

it('刷新详情真正重读导出，替换后显示新材料', async () => {
  let exported = detail
  const { calls } = start('/sources/tickets/items/T-1', () => Response.json(exported))
  expect(await screen.findByText(/"symptom": "未收到回执"/)).toBeVisible()
  exported = { ...detail, title: '订单回执缺失（已补充）', input: { ticket: 'T-1', symptom: '客户已二次催办' }, actions: ['inspect'] }
  await userEvent.click(screen.getByRole('button', { name: '刷新' }))
  expect(await screen.findByRole('heading', { name: '订单回执缺失（已补充）' })).toBeVisible()
  expect(screen.getByText(/"symptom": "客户已二次催办"/)).toBeVisible()
  expect(screen.queryByText(/"symptom": "未收到回执"/)).toBeNull()
  expect(within(screen.getByLabelText('固定动作')).queryAllByRole('option').map(option => option.textContent)).toEqual(['请选择动作', 'inspect'])
  expect(calls.filter(call => call.path === '/sources/tickets/items/T-1')).toHaveLength(2)
})

it('切换到另一条目时重新读取该条目的材料', async () => {
  const { router } = start('/sources/tickets/items/T-1', path =>
    Response.json(path.endsWith('/T-2')
      ? { ...detail, id: 'T-2', title: '另一张工单', input: { ticket: 'T-2', symptom: '新工单材料' }, actions: ['escalate'] }
      : detail))
  expect(await screen.findByRole('heading', { name: '订单回执缺失' })).toBeVisible()
  await act(async () => { await router.navigate('/sources/tickets/items/T-2') })
  expect(await screen.findByRole('heading', { name: '另一张工单' })).toBeVisible()
  expect(screen.getByText(/"symptom": "新工单材料"/)).toBeVisible()
  expect(screen.queryByText(/"symptom": "未收到回执"/)).toBeNull()
})

it('派工请求体恰为 requestId 与 action，成功后进入工作项', async () => {
  const { router, calls } = start('/sources/tickets/items/T-1', (_path, options) =>
    options.method === 'POST' ? Response.json({ id: 'I-9', status: 'pending' }) : Response.json(detail))
  await userEvent.selectOptions(await screen.findByLabelText('固定动作'), 'inspect')
  await userEvent.click(screen.getByRole('button', { name: '派工' }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/items/I-9'))
  const [post] = posts(calls)
  expect(post.path).toBe('/sources/tickets/items/T-1/dispatch')
  expect(Object.keys(json(post)).sort()).toEqual(['action', 'requestId'])
  expect(json(post).action).toBe('inspect')
  expect(json(post).requestId).toMatch(/^source-[0-9a-f]{32}$/)
  expect(new Headers(post.options.headers).get('Authorization')).toBe('Bearer demo-token')
})

it('响应丢失后重试沿用同一请求标识，只提交一张单', async () => {
  let attempts = 0
  const { router, calls } = start('/sources/tickets/items/T-1', (_path, options) => {
    if (options.method !== 'POST') return Response.json(detail)
    attempts += 1
    if (attempts === 1) throw new TypeError('Failed to fetch')
    return Response.json({ id: 'I-1', status: 'pending' })
  })
  await userEvent.selectOptions(await screen.findByLabelText('固定动作'), 'inspect')
  await userEvent.click(screen.getByRole('button', { name: '派工' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('沿用同一请求标识')
  expect(screen.getByLabelText('固定动作')).toHaveValue('inspect')
  await userEvent.click(screen.getByRole('button', { name: '派工' }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/items/I-1'))
  const sent = posts(calls)
  expect(sent).toHaveLength(2)
  expect(json(sent[0]).requestId).toBe(json(sent[1]).requestId)
  expect(json(sent[1]).action).toBe('inspect')
})

it('材料变化返回冲突时要求重新核对，不必静默重发，复核后使用新标识', async () => {
  let reads = 0
  let conflict = true
  const bodies: Record<string, unknown>[] = []
  const { router, calls } = start('/sources/tickets/items/T-1', (_path, options) => {
    if (options.method === 'POST') {
      bodies.push(JSON.parse(String(options.body)))
      if (conflict) return Response.json({ error: '来源动作与工作包版本不匹配' }, { status: 409 })
      return Response.json({ id: 'I-2', status: 'pending' })
    }
    reads += 1
    return Response.json(reads === 1 ? detail : { ...detail, input: { ticket: 'T-1', symptom: '导出已更新' } })
  })
  await userEvent.selectOptions(await screen.findByLabelText('固定动作'), 'inspect')
  await userEvent.click(screen.getByRole('button', { name: '派工' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('请核对材料与动作后重新派工')
  expect(router.state.location.pathname).toBe('/sources/tickets/items/T-1')
  expect(await screen.findByText(/"symptom": "导出已更新"/)).toBeVisible()
  expect(screen.getByLabelText('固定动作')).toHaveValue('')
  expect(posts(calls)).toHaveLength(1)

  conflict = false
  await userEvent.selectOptions(screen.getByLabelText('固定动作'), 'inspect')
  await userEvent.click(screen.getByRole('button', { name: '派工' }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/items/I-2'))
  expect(bodies).toHaveLength(2)
  expect(bodies[1].requestId).not.toBe(bodies[0].requestId)
})

it('条目已删除与服务不可用分别呈现，且可重新读取', async () => {
  let gone = true
  const { calls } = start('/sources/tickets/items/T-9', () =>
    gone ? Response.json({ error: '来源资源不存在' }, { status: 404 }) : Response.json({ error: '来源导出文件不可用' }, { status: 503 }))
  expect(await screen.findByText('条目已不可用')).toBeVisible()
  expect(screen.getByText(/已派出的单据仍保留当时的材料/)).toBeVisible()
  gone = false
  await userEvent.click(screen.getByRole('button', { name: '重新读取' }))
  expect(await screen.findByText('暂时无法读取来源条目')).toBeVisible()
  expect(screen.queryByText('条目已不可用')).toBeNull()
  expect(calls).toHaveLength(2)
})

it('派工时条目已被移除，页面要求重新核对来源而不是声称同步', async () => {
  let removed = false
  const { calls } = start('/sources/tickets/items/T-1', (_path, options) => {
    if (options.method === 'POST') {
      removed = true
      return Response.json({ error: '来源资源不存在' }, { status: 404 })
    }
    return removed ? Response.json({ error: '来源资源不存在' }, { status: 404 }) : Response.json(detail)
  })
  await userEvent.selectOptions(await screen.findByLabelText('固定动作'), 'escalate')
  await userEvent.click(screen.getByRole('button', { name: '派工' }))
  expect(await screen.findByText('条目已不可用')).toBeVisible()
  expect(posts(calls)).toHaveLength(1)
  expect(screen.queryByText(/已同步/)).toBeNull()
})

it('派工返回 503 时说明未建单且重试沿用同一请求标识', async () => {
  let attempts = 0
  const { calls } = start('/sources/tickets/items/T-1', (_path, options) => {
    if (options.method !== 'POST') return Response.json(detail)
    attempts += 1
    return Response.json({ error: '来源导出文件不可用' }, { status: 503 })
  })
  await userEvent.selectOptions(await screen.findByLabelText('固定动作'), 'inspect')
  await userEvent.click(screen.getByRole('button', { name: '派工' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('本次未创建单据')
  await userEvent.click(screen.getByRole('button', { name: '派工' }))
  await waitFor(() => expect(posts(calls)).toHaveLength(2))
  expect(attempts).toBe(2)
  const sent = posts(calls)
  expect(json(sent[0]).requestId).toBe(json(sent[1]).requestId)
})
