import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Link, MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { setToken } from '@/shared/http/session'
import { WorkList } from './WorkList'
import type { ItemSummary } from './model'

const item = (patch: Partial<ItemSummary> = {}): ItemSummary => ({
  id: 'I-1', package: 'triage', revision: 1, status: 'review', assignee: '林', source: { type: 'builtin' }, ...patch,
})

/** 详情页替身：把返回链接和状态筛选一起暴露出来，便于检查往返。 */
function Detail() {
  const location = useLocation()
  const status = new URLSearchParams(location.search).get('status')
  return <div>
    <p>办理详情 {location.pathname}</p>
    <Link to={status ? `/items?status=${status}` : '/items'}>返回工作清单</Link>
  </div>
}
function mount(handler: (path: string, options: RequestInit) => unknown, url = '/items') {
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
      <Route path="/items" element={<WorkList />} />
      <Route path="/items/new" element={<p>发起工作页</p>} />
      <Route path="/items/:id" element={<Detail />} />
      <Route path="/packages" element={<p>工作包目录页</p>} />
    </Routes>
  </MemoryRouter>)
  return fetchMock
}
const gets = (fetchMock: ReturnType<typeof mount>) => fetchMock.mock.calls.map(([path, options]) => [path, options.method ?? 'GET'])
afterEach(() => { cleanup(); setToken('') })

it('按状态筛选清单，行内可读包版本、单号和状态', async () => {
  const fetchMock = mount(() => [item()], '/items?status=review')

  const row = await screen.findByRole('link', { name: /triage/ })
  expect(gets(fetchMock)).toEqual([['/api/v2/items?status=review', 'GET']])
  expect(row).toHaveTextContent('triage')
  expect(row).toHaveTextContent('v1')
  expect(row).toHaveTextContent('I-1')
  expect(row).toHaveTextContent('待验收')
  expect(row).toHaveTextContent('内置派工')
  expect(row).toHaveTextContent('林')
  expect(row).toHaveAttribute('href', '/items/I-1?status=review')
  expect(screen.getByRole('link', { name: '待验收' })).toHaveAttribute('aria-current', 'page')
  console.info('[03-dispatch 抓包] 清单行', row.textContent)
})

it('从某行进入详情再返回，保留状态筛选', async () => {
  const user = userEvent.setup()
  const fetchMock = mount(() => [item()], '/items?status=review')

  await user.click(await screen.findByRole('link', { name: /triage/ }))
  expect(await screen.findByText('办理详情 /items/I-1')).toBeVisible()
  const back = screen.getByRole('link', { name: '返回工作清单' })
  expect(back).toHaveAttribute('href', '/items?status=review')

  await user.click(back)
  expect(await screen.findByRole('link', { name: /triage/ })).toBeVisible()
  expect(screen.getByRole('link', { name: '待验收' })).toHaveAttribute('aria-current', 'page')
  expect(gets(fetchMock).filter(([, method]) => method === 'GET')).toEqual([
    ['/api/v2/items?status=review', 'GET'], ['/api/v2/items?status=review', 'GET'],
  ])
})

it('筛选切换改查询状态，全部状态不带查询串', async () => {
  const user = userEvent.setup()
  const fetchMock = mount(() => [item({ status: 'pending' })], '/items')

  expect(await screen.findByRole('link', { name: /triage/ })).toHaveAttribute('href', '/items/I-1')
  await user.click(screen.getByRole('link', { name: '待办理' }))
  await waitFor(() => expect(gets(fetchMock)).toContainEqual(['/api/v2/items?status=pending', 'GET']))
  expect(await screen.findByRole('link', { name: '待办理', current: 'page' })).toBeVisible()
})

it('加载失败显示故障和重试，不把故障当成空清单', async () => {
  const user = userEvent.setup()
  let fail = true
  mount(() => (fail ? Response.json({ message: '存储不可用' }, { status: 503 }) : [item()]), '/items?status=review')

  expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 503：存储不可用')
  expect(screen.queryByText('暂无待验收工作项')).toBeNull()
  expect(screen.queryByRole('link', { name: /triage/ })).toBeNull()

  fail = false
  await user.click(screen.getByRole('button', { name: '重新加载' }))
  expect(await screen.findByRole('link', { name: /triage/ })).toBeVisible()
  expect(screen.queryByRole('alert')).toBeNull()
})

it('空清单给发起入口，筛选后的空态写明当前状态', async () => {
  mount(() => [], '/items')
  expect(await screen.findByText('暂无工作项')).toBeVisible()
  const entries = screen.getAllByRole('link', { name: '发起工作' })
  expect(entries.length).toBeGreaterThan(0)
  for (const entry of entries) expect(entry).toHaveAttribute('href', '/items/new')
})

it('筛选后的空态按状态命名', async () => {
  mount(() => [], '/items?status=delivered')
  expect(await screen.findByText('暂无已交付工作项')).toBeVisible()
})

it('桌面表头与移动逐项标签都覆盖五个字段', async () => {
  mount(() => [item({ assignee: null, source: { type: 'connector', provider: '工单来源', itemId: '101', action: '分析' } })])
  const row = await screen.findByRole('link', { name: /triage/ })
  for (const label of ['工作包', '单号', '来源', '经办人', '状态']) {
    expect(within(row).getByText(label)).toBeInTheDocument()
  }
  expect(row).toHaveTextContent('工单来源 · 101 · 分析')
  expect(row).toHaveTextContent('未指定')
})
