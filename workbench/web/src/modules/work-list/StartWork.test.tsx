import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import { Link, MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { setToken } from '@/shared/http/session'
import { StartWork } from './StartWork'
import type { WorkPackage } from './model'

const typedV1: WorkPackage = {
  id: 'triage', revision: 1, sop: '第 1 版 SOP：按材料逐项核查。', acceptance: '第 1 版验收标准：结论有证据。',
  deliverables: ['report.txt'],
  inputs: { ticket: 'string', count: 'number', retries: 'integer', urgent: 'boolean', meta: 'object', tags: 'array' },
  actions: {},
}
const typedV2: WorkPackage = {
  ...typedV1, revision: 2, sop: '第 2 版 SOP：换成新的核查顺序。', acceptance: '第 2 版验收标准：补齐复核。',
}
const plainV1: WorkPackage = {
  id: 'triage', revision: 1, sop: '第 1 版 SOP：按材料逐项核查。', acceptance: '第 1 版验收标准：结论有证据。',
  deliverables: ['report.txt'], inputs: { ticket: 'string' }, actions: {},
}
const plainV2: WorkPackage = { ...plainV1, revision: 2, sop: '第 2 版 SOP：换成新的核查顺序。', acceptance: '第 2 版验收标准：补齐复核。' }

const catalog = (pkg: WorkPackage = typedV2, active = true) => [{ ...pkg, active }]

function Detail() {
  const location = useLocation()
  return <div><p>办理详情 {location.pathname}</p><Link to="/items">返回工作清单</Link></div>
}
function mount(handler: (path: string, options: RequestInit) => unknown, url: string) {
  setToken('test-token')
  const fetchMock = vi.fn(async (path: string, options: RequestInit) => {
    const result = await handler(path, options)
    if (result instanceof Response) return result
    if (result === undefined) throw new Error(`意外请求 ${options.method ?? 'GET'} ${path}`)
    return Response.json(result)
  })
  vi.stubGlobal('fetch', fetchMock)
  render(<MemoryRouter initialEntries={[url]}>
    <Routes>
      <Route path="/items/new" element={<StartWork />} />
      <Route path="/items/:id" element={<Detail />} />
      <Route path="/items" element={<p>工作清单页</p>} />
      <Route path="/templates" element={<p>派工模板目录页</p>} />
    </Routes>
  </MemoryRouter>)
  return fetchMock
}
const posts = (fetchMock: ReturnType<typeof mount>) => fetchMock.mock.calls.filter(([, options]) => options.method === 'POST')
const sent = (options: RequestInit) => JSON.parse(String(options.body)) as {
  requestId: string; package: string; revision: number; input: Record<string, unknown>
}
/** user-event 把 `{` 和 `[` 当按键描述符，JSON 材料需要转义成双写。 */
const fill = (user: UserEvent, label: string, value: string) =>
  user.type(screen.getByLabelText(label), value.replaceAll('{', '{{').replaceAll('[', '[['))
afterEach(() => { cleanup(); setToken(''); vi.useRealTimers() })

it('深链指向 r1 时用 r1 的标准，六种声明按类型提交，false 和 0 照常发送', async () => {
  const user = userEvent.setup()
  const fetchMock = mount((path, options) => {
    if (path === '/api/v2/packages') return catalog()
    if (path === '/api/v2/packages/triage/revisions') return [typedV1, typedV2]
    if (path === '/api/v2/items' && options.method === 'POST') return { id: 'I-1', status: 'pending' }
  }, '/items/new?package=triage&revision=1')

  expect(await screen.findByText('第 1 版 SOP：按材料逐项核查。')).toBeVisible()
  expect(screen.getByText('第 1 版验收标准：结论有证据。')).toBeVisible()
  expect(screen.getByText('report.txt')).toBeVisible()
  expect(screen.getByLabelText('修订版本')).toHaveValue('1')
  expect(screen.queryByText('第 2 版验收标准：补齐复核。')).toBeNull()

  await fill(user, 'ticket', 'A-1')
  await fill(user, 'count', '0')
  await fill(user, 'retries', '3')
  await fill(user, 'meta', '{"a":1}')
  await fill(user, 'tags', '["x"]')
  await user.click(screen.getByRole('button', { name: '创建待办理工作项' }))

  expect(await screen.findByText('办理详情 /items/I-1')).toBeVisible()
  const [request] = posts(fetchMock)
  const body = sent(request[1])
  expect(Object.keys(body).sort()).toEqual(['input', 'package', 'requestId', 'revision'])
  expect(body).toMatchObject({ package: 'triage', revision: 1 })
  expect(body.input).toEqual({ ticket: 'A-1', count: 0, retries: 3, urgent: false, meta: { a: 1 }, tags: ['x'] })
  expect(body.requestId).toMatch(/^[0-9a-f]{32}$/)
  expect(request[0]).toBe('/api/v2/items')
})

it('错型在页面报错且不提交，保留已填内容，改正后按正确类型提交', async () => {
  const user = userEvent.setup()
  const fetchMock = mount((path, options) => {
    if (path === '/api/v2/packages') return catalog()
    if (path === '/api/v2/packages/triage/revisions') return [typedV1, typedV2]
    if (path === '/api/v2/items' && options.method === 'POST') return { id: 'I-2', status: 'pending' }
  }, '/items/new?package=triage&revision=2')

  await screen.findByLabelText('ticket')
  await fill(user, 'ticket', 'A-2')
  await fill(user, 'count', 'abc')
  await fill(user, 'meta', '["不是对象"]')
  await user.click(screen.getByRole('button', { name: '创建待办理工作项' }))

  expect(await screen.findAllByText('请填写数字。')).toHaveLength(2)
  expect(screen.getByText('需要一个 JSON 对象。')).toBeVisible()
  expect(screen.getByText('请填写 JSON 数组。')).toBeVisible()
  expect(screen.getByLabelText('count')).toHaveAttribute('aria-invalid', 'true')
  expect(posts(fetchMock)).toHaveLength(0)
  expect(screen.getByLabelText('ticket')).toHaveValue('A-2')
  expect(screen.getByLabelText('count')).toHaveValue('abc')
  expect(screen.getByLabelText('meta')).toHaveValue('["不是对象"]')

  await user.clear(screen.getByLabelText('retries'))
  await fill(user, 'retries', '2.5')
  await user.click(screen.getByRole('button', { name: '创建待办理工作项' }))
  expect(await screen.findByText('请填写整数。')).toBeVisible()
  expect(posts(fetchMock)).toHaveLength(0)

  await user.clear(screen.getByLabelText('count'))
  await fill(user, 'count', '2')
  await user.clear(screen.getByLabelText('retries'))
  await fill(user, 'retries', '0')
  await user.clear(screen.getByLabelText('meta'))
  await fill(user, 'meta', '{"a":1}')
  await fill(user, 'tags', '[]')
  await user.click(screen.getByRole('button', { name: '创建待办理工作项' }))

  expect(await screen.findByText('办理详情 /items/I-2')).toBeVisible()
  const body = sent(posts(fetchMock)[0][1])
  expect(body.input).toEqual({ ticket: 'A-2', count: 2, retries: 0, urgent: false, meta: { a: 1 }, tags: [] })
})

it('响应丢失后重试复用同一请求标识，只建一张单', async () => {
  const user = userEvent.setup()
  const requestIds: string[] = []
  let attempts = 0
  mount((path, options) => {
    if (path === '/api/v2/packages') return catalog(plainV2)
    if (path === '/api/v2/packages/triage/revisions') return [plainV1, plainV2]
    if (path === '/api/v2/items') {
      requestIds.push(sent(options).requestId)
      if (++attempts === 1) throw new TypeError('连接中断')
      return { id: 'I-3', status: 'pending' }
    }
  }, '/items/new?package=triage&revision=1')

  await screen.findByLabelText('ticket')
  await fill(user, 'ticket', 'A-3')
  await user.click(screen.getByRole('button', { name: '创建待办理工作项' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('连接中断')

  await user.click(screen.getByRole('button', { name: '创建待办理工作项' }))
  expect(await screen.findByText('办理详情 /items/I-3')).toBeVisible()
  expect(requestIds).toHaveLength(2)
  expect(new Set(requestIds).size).toBe(1)
  console.info('[03-dispatch 抓包] POST /api/v2/items 两次请求标识', requestIds)
})

it('连续点击只发一次请求', async () => {
  let resolvePost!: (value: unknown) => void
  const pending = new Promise(resolve => { resolvePost = resolve })
  const fetchMock = mount(path => {
    if (path === '/api/v2/packages') return catalog(plainV2)
    if (path === '/api/v2/packages/triage/revisions') return [plainV1, plainV2]
    if (path === '/api/v2/items') return pending
  }, '/items/new?package=triage&revision=1')

  await screen.findByLabelText('ticket')
  const button = screen.getByRole('button', { name: '创建待办理工作项' })
  await act(async () => { fireEvent.click(button); fireEvent.click(button) })
  await waitFor(() => expect(posts(fetchMock)).toHaveLength(1))
  expect(button).toBeDisabled()

  await act(async () => { resolvePost({ id: 'I-4', status: 'pending' }) })
  expect(await screen.findByText('办理详情 /items/I-4')).toBeVisible()
  expect(posts(fetchMock)).toHaveLength(1)
})

it('修改材料后按新参数生成新的请求标识', async () => {
  const user = userEvent.setup()
  const requestIds: string[] = []
  const fetchMock = mount((path, options) => {
    if (path === '/api/v2/packages') return catalog(plainV2)
    if (path === '/api/v2/packages/triage/revisions') return [plainV1, plainV2]
    if (path === '/api/v2/items') { requestIds.push(sent(options).requestId); throw new TypeError('连接中断') }
  }, '/items/new?package=triage&revision=1')

  await screen.findByLabelText('ticket')
  await fill(user, 'ticket', 'A-5')
  await user.click(screen.getByRole('button', { name: '创建待办理工作项' }))
  await waitFor(() => expect(requestIds).toHaveLength(1))
  await user.clear(screen.getByLabelText('ticket'))
  await fill(user, 'ticket', 'A-6')
  await user.click(screen.getByRole('button', { name: '创建待办理工作项' }))
  await waitFor(() => expect(requestIds).toHaveLength(2))
  expect(requestIds[0]).not.toBe(requestIds[1])
  expect(posts(fetchMock).map(([, options]) => sent(options).input.ticket)).toEqual(['A-5', 'A-6'])
})

it('派工模板目录加载失败给重试，重试成功后出表单', async () => {
  const user = userEvent.setup()
  let fail = true
  mount(path => {
    if (path === '/api/v2/packages') return fail ? Response.json({ message: '目录不可用' }, { status: 503 }) : catalog(plainV2)
    if (path === '/api/v2/packages/triage/revisions') return [plainV1, plainV2]
  }, '/items/new?package=triage&revision=1')

  expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 503：目录不可用')
  expect(screen.queryByText(/不存在/)).toBeNull()
  expect(screen.queryByLabelText('ticket')).toBeNull()
  fail = false
  await user.click(screen.getByRole('button', { name: '重新加载' }))
  expect(await screen.findByText('第 1 版 SOP：按材料逐项核查。')).toBeVisible()
  expect(screen.getByLabelText('修订版本')).toHaveValue('1')
})

it('没有可派工版本时给派工模板目录入口', async () => {
  mount(path => {
    if (path === '/api/v2/packages') return []
  }, '/items/new')
  expect(await screen.findByText('暂无可用派工模板')).toBeVisible()
  expect(screen.getByRole('link', { name: '进入派工模板目录' })).toHaveAttribute('href', '/templates')
  expect(screen.queryByLabelText('ticket')).toBeNull()
})

it('深链指向停用的派工模板时拒绝派工，可改选其他模板或进目录', async () => {
  const user = userEvent.setup()
  const other: WorkPackage = { ...plainV2, id: 'review', sop: '复核包 SOP。', acceptance: '复核包验收。' }
  const fetchMock = mount(path => {
    if (path === '/api/v2/packages') return [...catalog(plainV2, false), { ...other, active: true }]
    if (path === '/api/v2/packages/triage/revisions') return [plainV1, plainV2]
    if (path === '/api/v2/packages/review/revisions') return [other]
  }, '/items/new?package=triage&revision=1')

  expect(await screen.findByRole('alert')).toHaveTextContent('派工模板 triage 停用')
  expect(screen.getByRole('link', { name: '进入派工模板目录' })).toHaveAttribute('href', '/templates')
  expect(screen.queryByLabelText('ticket')).toBeNull()
  expect(posts(fetchMock)).toHaveLength(0)

  await user.selectOptions(screen.getByLabelText('派工模板'), 'review')
  expect(await screen.findByText('复核包 SOP。')).toBeVisible()
})
