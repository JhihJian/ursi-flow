import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { setToken } from '@/shared/http/session'
import { WorkDetail } from './WorkDetail'
import type { WorkItem, Attempt, Delivery } from './model'

const executor = { id: '排查助手', revision: 2, kind: 'agent' } as const
const attempt: Attempt = { id: 'a1', action: '分析', executor, status: 'running', output: null, workspace: 'default', backendRunId: 'a1' }
const report = (version: number, review: Delivery['review'] = null): Delivery => ({ version, review, files: { '报告 #1.txt': '文件接口单独读取' }, attemptIds: [] })
const item = (patch: Partial<WorkItem> = {}): WorkItem => ({ id: 'I', package: '排查包', revision: 1, status: 'working', assignee: '林', input: { ticket: '101' }, source: { type: 'builtin' }, acceptedVersion: null,
  attempts: [], deliveries: [], packageSnapshot: { sop: '开单时的步骤', acceptance: '原版验收标准', deliverables: ['report.txt'], actions: { 分析: { executor, resources: [] }, 复核: { executor, resources: [] } } }, ...patch })
const base = '/api/v2/items/I'
function mount(handler: (path: string, options: RequestInit) => unknown, url = '/items/I?status=working') {
  setToken('test-token')
  const fetch = vi.fn(async (path: string, options: RequestInit) => {
    const result = await handler(path, options)
    if (result instanceof Response) return result
    if (result === undefined) throw new Error(`意外请求 ${options.method ?? 'GET'} ${path}`)
    return Response.json(result)
  })
  vi.stubGlobal('fetch', fetch)
  render(<MemoryRouter initialEntries={[url]}><Routes>{['/items/:id', '/items/:id/deliveries/:version'].map(path => <Route path={path} key={path} element={<WorkDetail />} />)}</Routes></MemoryRouter>)
  return fetch
}
const tab = (name: string) => fireEvent.click(screen.getByRole('tab', { name }))
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }))
const fill = (name: string, value: string) => fireEvent.change(screen.getByLabelText(name), { target: { value } })
const button = (name: string) => screen.getByRole('button', { name })
const conflict = () => Response.json({ message: '已变更' }, { status: 409 })
afterEach(() => { cleanup(); setToken(''); vi.useRealTimers() })

it('来源办理单使用旧快照，只派发获准动作；轮询单项直到终态', async () => {
  const original = item({ status: 'pending', assignee: null, source: { type: 'connector', action: '分析', provider: '工单来源' } })
  let queries = 0
  const fetch = mount((p, o) => {
    if (p === base) return original
    if (p === `${base}/start`) { expect(JSON.parse(String(o.body))).toEqual({ assignee: '林' }); return { ...original, status: 'working', assignee: '林' } }
    if (p === `${base}/attempts` && o.method === 'POST') { expect(JSON.parse(String(o.body))).toEqual({ action: '分析' }); return attempt }
    if (p === `${base}/attempts/a1`) return ++queries === 1 ? attempt : { ...attempt, status: 'succeeded', output: '本次报告' }
  })
  await screen.findByText('开单时的步骤')
  expect(screen.getByRole('link', { name: '返回工作清单' })).toHaveAttribute('href', '/items?status=working')
  expect(screen.getByRole('tab', { name: '办理' })).toHaveAttribute('aria-selected', 'true')
  expect(button('开始办理')).toBeDisabled()
  fill('经办人', '林'); click('开始办理')
  expect(within(await screen.findByRole('combobox', { name: '动作' })).getAllByRole('option').map(o => o.textContent)).toEqual(['分析'])
  expect(screen.getByText('绑定执行器：排查助手 v2')).toBeVisible()
  vi.useFakeTimers()
  await act(async () => click('执行一次'))
  expect(queries).toBe(1)
  await act(async () => vi.advanceTimersByTimeAsync(2000))
  expect(screen.getByText('本次报告')).toBeVisible()
  expect(screen.getByText('工作项状态：办理中')).toBeVisible()
  await act(async () => vi.advanceTimersByTimeAsync(8000))
  expect(queries).toBe(2)
  expect(fetch.mock.calls.filter(([p, o]) => p.endsWith('/attempts') && o.method === 'POST')).toHaveLength(1)
  expect(fetch.mock.calls.every(([p]) => p.startsWith(base))).toBe(true)
})

it('派发响应丢失只查历史和单项；取消显示服务器最终结果', async () => {
  let result = attempt
  const fetch = mount((p, o) => {
    if (p === base) return item()
    if (p.endsWith('/attempts')) { if (o.method === 'POST') throw new TypeError('连接中断'); return [result] }
    if (p.endsWith('/a1/cancel')) { result = { ...attempt, status: 'succeeded', output: '恰好已完成' }; return result }
    if (p.endsWith('/a1')) return result
  })
  fireEvent.click(await screen.findByRole('button', { name: '执行一次' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('未自动重试')
  await waitFor(() => expect(fetch.mock.calls.map(([p]) => p)).toEqual([base, `${base}/attempts`, `${base}/attempts`, `${base}/attempts/a1`]))
  click('取消本次执行')
  expect(await screen.findByText('恰好已完成')).toBeVisible()
  expect(screen.queryByRole('button', { name: '取消本次执行' })).toBeNull()
})

it('阻止待核实尝试交付，可定位对应记录并提交有效证据', async () => {
  let result: Attempt = { ...attempt, status: 'unverified', executor: { ...executor, environment: 'sandbox' }, workspace: 'case-box', backendRunId: 'session-82' }
  const fetch = mount((p, o) => {
    if (p === base) return item({ attempts: [result] })
    if (p.endsWith('/a1')) return result
    if (p.endsWith('/verify')) {
      const body = JSON.parse(String(o.body)); expect(body).toEqual({ status: 'cancelled', evidence: '审计记录', reason: '会话已停止' })
      result = { ...result, status: body.status, verification: body }; return result
    }
  })
  await screen.findByRole('tablist'); tab('交付与验收'); fill('文件正文：report.txt', '已核对')
  expect(button('提交交付')).toBeDisabled(); click('分析 · 待核实 · a1')
  expect(await screen.findByText('会话标识：session-82')).toBeVisible()
  expect(screen.queryByRole('link', { name: /Run/ })).toBeNull()
  expect(button('提交核实')).toBeDisabled()
  expect(within(screen.getByLabelText('核实结论')).getAllByRole('option').map(o => o.textContent)).toEqual(['失败', '取消'])
  fill('核实结论', 'cancelled'); fill('核实原因', '会话已停止'); fill('核实证据', '证'.repeat(1400)); expect(button('提交核实')).toBeDisabled()
  fill('核实证据', '审计记录'); click('提交核实'); expect(await screen.findByText('证据：审计记录')).toBeVisible()
  tab('交付与验收'); expect(button('提交交付')).toBeEnabled()
  expect(fetch.mock.calls.filter(([, o]) => o.method === 'POST')).toHaveLength(1)
})

it('过时的验收遇到 409 重读工作项，草稿留在旧版，打开新版必须重新填验收', async () => {
  let reads = 0
  const rejected = { reviewer: '陈', decision: 'reject', comment: '请补复核结果' } as const
  const fetch = mount((p, o) => {
    if (p === base) return item({ status: 'review', deliveries: ++reads === 1 ? [report(1)] : [report(1, rejected), report(2)] })
    if (p.endsWith('/1/review')) { expect(JSON.parse(String(o.body))).toEqual({ decision: 'reject', reviewer: '林', comment: '迟到的意见' }); return conflict() }
    if (p.endsWith(`/files/${encodeURIComponent('报告 #1.txt')}`)) return new Response(p.includes('/1/') ? '初稿正文' : '复核正文')
  }, '/items/I?status=review')
  expect(await screen.findByText('初稿正文')).toBeVisible()
  expect(screen.getByRole('tab', { name: '交付与验收' })).toHaveAttribute('aria-selected', 'true')
  expect(button('通过')).toBeDisabled(); fill('验收人', '林'); expect(button('退回')).toBeDisabled(); fill('验收意见', '迟到的意见'); click('退回')
  expect(await screen.findByText('迟到的意见', { selector: 'p' })).toBeVisible()
  expect(screen.getByText('初稿正文')).toBeVisible(); expect(screen.queryByRole('button', { name: '通过' })).toBeNull()
  const newer = screen.getByRole('link', { name: '第 2 版（当前）' }); expect(newer).toHaveAttribute('href', '/items/I/deliveries/2?status=review'); fireEvent.click(newer)
  expect(await screen.findByText('复核正文')).toBeVisible(); expect(screen.getByLabelText('验收意见')).toHaveValue(''); expect(button('通过')).toBeDisabled()
  expect(fetch.mock.calls.filter(([, o]) => o.method === 'POST')).toHaveLength(1)
})

it('提交遇冲突后只读保留正文，不自动补交', async () => {
  let latest = item()
  const fetch = mount(p => {
    if (p === base) return latest
    if (p.endsWith('/deliveries')) { latest = item({ status: 'review', deliveries: [report(1)] }); return conflict() }
    if (p.includes('/files/')) return new Response('另一人已提交的正文')
  })
  await screen.findByRole('tablist'); tab('交付与验收'); fill('文件正文：report.txt', '尚未提交的正文'); click('提交交付')
  expect(await screen.findByText('未提交的交付草稿（只读）')).toBeVisible()
  expect(screen.getByLabelText('文件正文：report.txt')).toHaveValue('尚未提交的正文')
  expect(screen.getByLabelText('文件正文：report.txt')).toBeDisabled()
  expect(fetch.mock.calls.filter(([, o]) => o.method === 'POST')).toHaveLength(1)
})

it('切换深链时停止旧文件读取，新版文件加载失败前后都不会误审旧正文', async () => {
  let finish!: (value: Response) => void
  const slow = new Promise<Response>(resolve => { finish = resolve })
  let fail = true
  const fetch = mount(p => {
    if (p === base) return item({ status: 'review', deliveries: [report(1), report(2)] })
    if (p.includes('/1/files/')) return slow
    if (p.includes('/2/files/')) return fail ? Response.json({}, { status: 503 }) : new Response('第二版正文')
  }, '/items/I/deliveries/1')
  const next = await screen.findByRole('link', { name: '第 2 版（当前）' }); fireEvent.click(next)
  expect(await screen.findByRole('alert')).toHaveTextContent('503'); expect(screen.queryByRole('button', { name: '通过' })).toBeNull()
  expect(fetch.mock.calls.find(([p]) => p.includes('/1/files/'))?.[1].signal?.aborted).toBe(true)
  fail = false; click('重新加载'); expect(await screen.findByText('第二版正文')).toBeVisible()
  await act(async () => finish(new Response('迟到的旧版正文')))
  expect(screen.queryByText('迟到的旧版正文')).toBeNull(); expect(button('通过')).toBeDisabled()
})

it.each(['9', 'bad', '01'])('无效深链 %s 不展示当前版文件或操作', async version => {
  const fetch = mount(p => p === base && item({ status: 'review', deliveries: [report(1)] }), `/items/I/deliveries/${version}`)
  expect(await screen.findByRole('alert')).toHaveTextContent('交付版本不存在')
  expect(screen.queryByRole('button', { name: '通过' })).toBeNull(); expect(fetch).toHaveBeenCalledTimes(1)
})

it('提交所有必需文件与选定尝试，退回后可同单再交，已通过版保留深链', async () => {
  const original = item({ attempts: [{ ...attempt, status: 'succeeded' }] })
  original.packageSnapshot.deliverables = ['report.txt', '复核.txt']
  let latest = original
  mount((p, o) => {
    if (p === base) return latest
    if (p.endsWith('/deliveries')) {
      const { files, attemptIds } = JSON.parse(String(o.body)); expect(Object.keys(files)).toEqual(['report.txt', '复核.txt'])
      if (latest.deliveries.length === 0) expect(attemptIds).toEqual(['a1'])
      latest = { ...latest, status: 'review', deliveries: [...latest.deliveries, { version: latest.deliveries.length + 1, files, attemptIds, review: null }] }; return latest
    }
    if (p.endsWith('/review')) {
      const review = JSON.parse(String(o.body)), n = latest.deliveries.length
      expect(p).toBe(`${base}/deliveries/${n}/review`)
      latest = { ...latest, status: review.decision === 'reject' ? 'working' : 'delivered', acceptedVersion: review.decision === 'accept' ? n : null,
        deliveries: latest.deliveries.map(d => d.version === n ? { ...d, review } : d) }; return latest
    }
    if (p.includes('/files/')) { const [, version, name] = p.match(/deliveries\/(\d+)\/files\/(.+)$/)!; return new Response(latest.deliveries[Number(version) - 1].files[decodeURIComponent(name)]) }
  })
  await screen.findByRole('tablist'); tab('交付与验收'); fill('文件正文：report.txt', '初稿'); expect(button('提交交付')).toBeDisabled(); fill('文件正文：复核.txt', '记录')
  fireEvent.click(screen.getByRole('checkbox')); click('提交交付'); await screen.findByRole('button', { name: '退回' }); fill('验收人', '陈'); fill('验收意见', '补充证据'); click('退回')
  await waitFor(() => expect(screen.getByRole('tab', { name: '办理' })).toHaveAttribute('aria-selected', 'true'))
  expect(within(screen.getByRole('tabpanel')).getByText('补充证据')).toBeVisible(); tab('交付与验收')
  fill('文件正文：report.txt', '定稿'); fill('文件正文：复核.txt', '已补证据'); click('提交交付'); await screen.findByText('定稿', { selector: 'pre' }); fill('验收人', '陈'); click('通过')
  expect(await screen.findByRole('link', { name: '第 2 版（已通过）' })).toBeVisible(); expect(screen.getByText('工作项状态：已交付')).toBeVisible()
  fireEvent.click(screen.getByRole('link', { name: '第 1 版' })); expect(await screen.findByText('初稿', { selector: 'pre' })).toBeVisible(); expect(within(screen.getByRole('tabpanel')).getByText('补充证据')).toBeVisible()
  expect(screen.queryByRole('button', { name: '退回' })).toBeNull()
})
