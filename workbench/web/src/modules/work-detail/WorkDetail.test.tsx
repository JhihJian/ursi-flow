import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { setToken } from '@/shared/http/session'
import { WorkDetail } from './WorkDetail'
import type { WorkItem, Attempt, Delivery } from './model'

const executor = { id: '排查助手', revision: 2, kind: 'agent' } as const
const workspace = (id = 'default'): Attempt['workspace'] => ({ id, access: 'read-write', purpose: 'work-input' })
const attempt: Attempt = { id: 'a1', action: '分析', executor, status: 'running', output: null, workspace: workspace(), backendRunId: 'a1',
  workInstruction: null, artifactDirectory: null, platformLog: [], executorLog: null, executorLogPage: null }
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
  expect(screen.getByText('绑定执行器：排查助手 v2（本地 Agent）')).toBeVisible()
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
  let result: Attempt = { ...attempt, status: 'unverified', executor: { ...executor, environment: 'sandbox' }, workspace: workspace('case-box'), backendRunId: 'session-82' }
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
  fail = false; click('重新读取文件'); expect(await screen.findByText('第二版正文')).toBeVisible()
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

it('待验收与已交付默认落位交付，返回清单保留状态筛选', async () => {
  mount(p => {
    if (p === base) return item({ status: 'delivered', acceptedVersion: 1, deliveries: [report(1, { reviewer: '陈', decision: 'accept', comment: '可以交付' })] })
    if (p.includes('/files/')) return new Response('存档正文')
  }, '/items/I?status=delivered')
  expect(await screen.findByRole('tab', { name: '交付与验收' })).toHaveAttribute('aria-selected', 'true')
  expect(screen.getByRole('link', { name: '返回工作清单' })).toHaveAttribute('href', '/items?status=delivered')
  expect(screen.getByRole('link', { name: '第 1 版（已通过）' })).toBeVisible()
  expect(await screen.findByText('存档正文', { selector: 'pre' })).toBeVisible()
  expect(screen.queryByRole('button', { name: '通过' })).toBeNull()
})

it.each([
  ['读取错误', () => Response.json({ message: '读取失败' }, { status: 500 })],
  ['空响应', () => new Response('')],
  ['HTML 页面', () => new Response('<!doctype html><title>登录</title>', { headers: { 'Content-Type': 'text/html' } })],
])('第 2 版有一份文件%s时指出该文件并禁止通过', async (_, broken) => {
  let failing = true
  const delivery: Delivery = { version: 2, files: { 'report.txt': '第一份正文', '复核.txt': '第二份正文' }, attemptIds: [], review: null }
  const fetch = mount(p => {
    if (p === base) return item({ status: 'review', deliveries: [report(1), delivery] })
    if (p.includes('/2/files/')) {
      const name = decodeURIComponent(p.split('/files/')[1])
      if (name === '复核.txt' && failing) return broken()
      return new Response(name === '复核.txt' ? '第二份正文' : '第一份正文')
    }
    if (p.includes('/1/files/')) return new Response('第一版正文')
  }, '/items/I/deliveries/2')
  expect(await screen.findByText(/文件「复核\.txt」不可读/)).toBeVisible()
  expect(screen.getByText('第一份正文', { selector: 'pre' })).toBeVisible()
  expect(screen.getByText(/不能验收/)).toBeVisible()
  expect(screen.queryByRole('button', { name: '通过' })).toBeNull()
  expect(fetch.mock.calls.filter(([, o]) => o.method === 'POST')).toHaveLength(0)
  failing = false
  fireEvent.click(screen.getByRole('button', { name: '重新读取文件' }))
  expect(await screen.findByText('第二份正文', { selector: 'pre' })).toBeVisible()
  expect(screen.getByRole('button', { name: '通过' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '退回' })).toBeDisabled()
})

it('版本深链刷新仍显示该版文件、意见与通过版本', async () => {
  mount(p => {
    if (p === base) return item({ status: 'delivered', acceptedVersion: 1, deliveries: [report(1, { reviewer: '陈', decision: 'accept', comment: '可以交付' }), report(2)] })
    if (p.includes('/1/files/')) return new Response('第一版定稿')
    if (p.includes('/2/files/')) return new Response('第二版草稿')
  }, '/items/I/deliveries/1?status=delivered')
  expect(await screen.findByText('第一版定稿', { selector: 'pre' })).toBeVisible()
  expect(screen.getByText('可以交付')).toBeVisible()
  expect(screen.getByRole('link', { name: '第 1 版（已通过）' })).toBeVisible()
  expect(screen.getByRole('link', { name: '返回工作清单' })).toHaveAttribute('href', '/items?status=delivered')
  expect(screen.queryByRole('button', { name: '通过' })).toBeNull()
  expect(screen.queryByText('第二版草稿')).toBeNull()
})

it('两标签页：B 已提交 v1 时 A 的提交收到 409，重读后保留草稿且不重发', async () => {
  const user = userEvent.setup()
  let latest = item()
  let posts = 0
  mount((p, o) => {
    if (p === base) return latest
    if (p.endsWith('/deliveries') && o.method === 'POST') {
      posts += 1
      latest = item({ status: 'review', deliveries: [{ version: 1, files: { 'report.txt': 'B 的正文' }, attemptIds: [], review: null }] })
      return conflict()
    }
    if (p.includes('/files/')) return new Response('B 的正文')
  })
  await screen.findByRole('tablist')
  await user.click(screen.getByRole('tab', { name: '交付与验收' }))
  await user.type(screen.getByLabelText('文件正文：report.txt'), 'A 的旧稿')
  expect(screen.queryByText('B 的正文')).toBeNull()
  await user.click(screen.getByRole('button', { name: '提交交付' }))
  expect(await screen.findByText(/状态冲突/)).toBeVisible()
  expect(await screen.findByText('B 的正文', { selector: 'pre' })).toBeVisible()
  expect(screen.getByText('工作项状态：待验收')).toBeVisible()
  expect(screen.getByText('未提交的交付草稿（只读）')).toBeVisible()
  expect(screen.getByLabelText('文件正文：report.txt')).toHaveValue('A 的旧稿')
  expect(screen.getByLabelText('文件正文：report.txt')).toBeDisabled()
  expect(posts).toBe(1)
  expect(screen.queryByRole('button', { name: '提交交付' })).toBeNull()
  // C 退回 v1 后工作项回到办理中；刷新后 A 的旧稿仍在，且在重新提交前能看到最新退回意见。
  latest = item({ status: 'working', deliveries: [{ version: 1, files: { 'report.txt': 'B 的正文' }, attemptIds: [], review: { reviewer: '陈', decision: 'reject', comment: '请补复核结论' } }] })
  fireEvent.click(screen.getByRole('button', { name: '刷新' }))
  expect(await screen.findByText('第 1 版被退回 · 陈')).toBeVisible()
  const notice = screen.getByText('第 1 版被退回 · 陈').closest('aside')!
  expect(within(notice).getByText('请补复核结论')).toBeVisible()
  expect(screen.getByText('工作项状态：办理中')).toBeVisible()
  expect(screen.getByLabelText('文件正文：report.txt')).toHaveValue('A 的旧稿')
  expect(screen.getByLabelText('文件正文：report.txt')).toBeEnabled()
  expect(posts).toBe(1)
})

it('竞态证据：B 的 v1 被退回后，A 的旧稿不经确认直接成为 v2', async () => {
  const user = userEvent.setup()
  let latest = item()
  const bodies: unknown[] = []
  mount((p, o) => {
    if (p === base) return latest
    if (p.endsWith('/deliveries') && o.method === 'POST') {
      const body = JSON.parse(String(o.body)) as { files: Record<string, string> }
      bodies.push(body)
      // 服务端只校验当前状态为 working，不校验 A 起草时看到的最后交付版本。
      if (latest.status !== 'working') return conflict()
      latest = { ...latest, status: 'review', deliveries: [...latest.deliveries, { version: latest.deliveries.length + 1, files: body.files, attemptIds: [], review: null }] }
      return latest
    }
    if (p.includes('/files/')) return new Response('A 的旧稿')
  })
  await screen.findByRole('tablist')
  await user.click(screen.getByRole('tab', { name: '交付与验收' }))
  await user.type(screen.getByLabelText('文件正文：report.txt'), 'A 的旧稿')
  latest = item({ status: 'working', deliveries: [{ version: 1, files: { 'report.txt': 'B 的正文' }, attemptIds: [], review: { reviewer: '陈', decision: 'reject', comment: '请补复核结论' } }] })
  expect(screen.queryByText('请补复核结论')).toBeNull()
  await user.click(screen.getByRole('button', { name: '提交交付' }))
  expect(await screen.findByRole('link', { name: '第 2 版（当前）' })).toBeVisible()
  expect(bodies).toEqual([{ files: { 'report.txt': 'A 的旧稿' }, attemptIds: [] }])
  expect(screen.queryByText('请补复核结论')).toBeNull()
})

it('执行记录分别呈现失败、Flow 与沙箱的后端信息', async () => {
  const failed: Attempt = { ...attempt, id: 'f1', status: 'failed', output: '进程退出码 1', backendRunId: 'f1' }
  const flow: Attempt = { ...attempt, id: 'r1', action: '汇总', executor: { id: '汇总流程', revision: 3, kind: 'flow', flowId: 'daily', flowRevision: 'v3' }, status: 'succeeded', output: '流程输出', backendRunId: 'r1' }
  const box: Attempt = { ...attempt, id: 's1', action: '复核', executor: { ...executor, environment: 'sandbox' }, status: 'succeeded', output: '沙箱输出', workspace: workspace('case-7'), backendRunId: 'session-9' }
  mount(p => {
    if (p === base) return item({ attempts: [failed, flow, box] })
    const found = [failed, flow, box].find(a => p.endsWith(`/attempts/${a.id}`))
    if (found) return found
  })
  await screen.findByRole('tablist'); tab('执行记录')
  expect(screen.getByText('执行失败')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: /汇总/ }))
  expect(await screen.findByText('流程输出')).toBeVisible()
  expect(screen.getByRole('link', { name: /Run/ })).toHaveAttribute('href', '/runs/r1')
  expect(screen.getByText('Flow · default')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: /复核/ }))
  expect(await screen.findByText('会话标识：session-9')).toBeVisible()
  expect(screen.getByText('沙箱 · case-7')).toBeVisible()
  expect(screen.queryByRole('link', { name: /Run/ })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /分析/ }))
  expect(await screen.findByText('进程退出码 1')).toBeVisible()
})

it('执行详情依次展示平台日志、执行器日志与制品目录，且不伪造自定义日志链接', async () => {
  const settled: Attempt = {
    ...attempt, status: 'succeeded', output: '执行完成', artifactDirectory: { id: 'art-1', state: 'frozen' },
    platformLog: [
      { sequence: 1, occurredAt: 1, source: 'platform', event: 'attempt_created', message: '已分配', attemptStatus: 'running' },
      { sequence: 2, occurredAt: 2, source: 'platform', event: 'attempt_closed', message: '执行结束：成功', attemptStatus: 'succeeded' },
    ],
    executorLog: { source: 'agent', kind: 'text', entries: [{ sequence: 1, occurredAt: 2, stream: 'stdout', text: '报告已生成' }] },
    executorLogPage: null,
  }
  const bare: Attempt = { ...attempt, id: 'a2', action: '核查', status: 'succeeded', artifactDirectory: null }
  const fetch = mount(p => {
    if (p === base) return item({ attempts: [settled, bare] })
    if (p.endsWith('/a1')) return settled
    if (p.endsWith('/a2')) return bare
    if (p === '/api/v2/directories/art-1/tree') return [{ path: '证据', kind: 'dir' }, { path: '报告.md', kind: 'file', size: 12 }]
  })
  await screen.findByRole('tablist'); tab('执行记录')
  fireEvent.click(screen.getByRole('button', { name: /分析/ }))
  expect(await screen.findByText('报告.md')).toBeVisible()
  expect(screen.getByText('证据')).toBeVisible()
  expect(screen.getByText('已记录 2 条，日志查看器待实现')).toBeVisible()
  expect(screen.getByText('已记录 1 条，日志查看器待实现')).toBeVisible()
  const headings = screen.getAllByRole('heading').map(node => node.textContent)
  expect(headings.indexOf('平台记录日志')).toBeGreaterThan(-1)
  expect(headings.indexOf('平台记录日志')).toBeLessThan(headings.indexOf('执行器记录日志'))
  expect(headings.indexOf('执行器记录日志')).toBeLessThan(headings.indexOf('制品目录'))
  // 没有真实的自定义日志页地址时不渲染链接。
  expect(screen.queryByRole('link', { name: /日志/ })).toBeNull()
  expect(fetch.mock.calls.filter(([p]) => p.includes('/directories/art-1/tree'))).toHaveLength(1)

  fireEvent.click(screen.getByRole('button', { name: /核查/ }))
  expect(screen.getByText('无制品目录')).toBeVisible()
  expect(screen.getByRole('heading', { name: '平台记录日志' })).toBeVisible()
  expect(screen.getByText('暂无平台记录')).toBeVisible()
  expect(screen.getByText('暂无执行器记录')).toBeVisible()
  // 没有制品目录时不会去读取目录清单。
  expect(fetch.mock.calls.some(([p]) => p.includes('/directories/'))).toBe(true)
  expect(screen.queryByRole('link', { name: /日志/ })).toBeNull()
})
