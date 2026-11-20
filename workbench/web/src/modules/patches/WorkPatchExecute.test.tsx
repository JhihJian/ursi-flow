import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'
import { setToken } from '@/shared/http/session'
import type { AttemptTarget } from '@/shared/api/agent-executor'
import { patchRoutes } from './routes'

// 指令、实际发起请求和结果由共享面板测试；这里观察工作包页传入的公开契约。
vi.mock('@/modules/agent-executor/AttemptPanel', () => ({
  AttemptPanel: (props: { target: AttemptTarget | null; storageKey: string; workPatchId: string }) =>
    <output data-testid="attempt-panel">{JSON.stringify(props)}</output>,
}))

const packages = [
  { id: 'w1', name: '交付整理', directoryId: 'd1' },
  { id: 'w2', name: '回归排查', directoryId: 'd2' },
]
const agent = { systemPrompt: '核查', modelProfile: 'managed', tools: [] }
const refs = [1, 2, 3].map(revision => ({ id: 'review', revision, resources: [], ...(revision !== 3 && { agent }) }))
function serve(path: string): Response {
  if (path === '/patches/work') return Response.json(packages)
  const patch = packages.find(item => path === `/patches/work/${item.id}`)
  if (patch) return Response.json(patch)
  if (path === '/executors') return Response.json([
    { id: 'review', revision: 3, active: true }, { id: 'check', revision: 1, active: true }, { id: 'disabled', revision: 2, active: false },
  ])
  if (path === '/executors/review/revisions') return Response.json(refs)
  if (path === '/executors/check/revisions') return Response.json([{ id: 'check', revision: 1, agent }])
  return Response.json({ error: '不存在' }, { status: 404 })
}

function mount(path: string, handle = serve) {
  const calls: string[] = []
  setToken('patch-test')
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = url.replace('/api/v2', '')
    calls.push(path)
    return handle(path)
  }))
  const router = createMemoryRouter(patchRoutes, { initialEntries: [path] })
  render(<RouterProvider router={router} />)
  return { calls, router }
}

function panel() { return JSON.parse(screen.getByTestId('attempt-panel').textContent!) }

afterEach(() => { cleanup(); setToken(''); vi.unstubAllGlobals() })

it('从列表进入，按需读取所选启用执行器的完整历史，把旧修订固定到当前包', async () => {
  const user = userEvent.setup()
  const { calls, router } = mount('/work-patches')
  await user.click((await screen.findAllByRole('link', { name: '运行工作包' }))[0]!)
  const executor = await screen.findByRole('combobox', { name: /^执行器/ })
  expect(router.state.location.pathname).toBe('/work-patches/w1/execute')
  expect(calls).toEqual(['/patches/work', '/patches/work/w1', '/executors'])
  expect(screen.queryByRole('option', { name: 'disabled' })).toBeNull()
  expect(panel().target).toBeNull()

  await user.selectOptions(executor, 'review')
  const revision = await screen.findByRole('combobox', { name: /^修订/ })
  expect(screen.getAllByRole('option', { name: /^review @/ })).toHaveLength(3)
  expect(screen.getByRole('option', { name: /review @3/ })).toBeDisabled()
  await user.selectOptions(revision, '1')
  const { storageKey } = panel()
  expect(storageKey).toBeTruthy()
  expect(panel()).toEqual({ workPatchId: 'w1', storageKey, target: { executorRef: { id: 'review', revision: 1 } } })
  expect(calls).toEqual(['/patches/work', '/patches/work/w1', '/executors', '/executors/review/revisions'])

  await user.selectOptions(executor, 'check')
  await screen.findByRole('option', { name: 'check @1' })
  expect(screen.queryByRole('option', { name: /^review @/ })).toBeNull()
  expect(panel().target).toBeNull()

  await act(async () => { await router.navigate('/work-patches/w2/execute') })
  await screen.findByText('回归排查')
  expect(panel().workPatchId).toBe('w2')
  expect(panel().target).toBeNull()
  expect(panel().storageKey).not.toBe(storageKey)
})

it('深链先核对单个工作包；读取失败可重试，404 不进入运行面板或加载目录', async () => {
  let ok = false
  const { calls } = mount('/work-patches/missing/execute', path => ok ? serve(path) : Response.json({}, { status: 503 }))
  await screen.findByRole('heading', { name: '读取工作包失败' })
  ok = true
  await userEvent.setup().click(screen.getByRole('button', { name: '重新加载' }))
  expect(await screen.findByRole('heading', { name: '没有找到这个工作包' })).toBeVisible()
  expect(screen.queryByTestId('attempt-panel')).toBeNull()
  expect(screen.getByRole('link', { name: '全部工作包' })).toHaveAttribute('href', '/work-patches')
  expect(calls).toEqual(['/patches/work/missing', '/patches/work/missing'])
})

it('修订加载失败时不能沿用其他目标，重试后可选当前执行器的旧修订', async () => {
  let fail = true
  const user = userEvent.setup()
  mount('/work-patches/w1/execute', path => fail && path.endsWith('/revisions') ? Response.json({}, { status: 503 }) : serve(path))
  await user.selectOptions(await screen.findByRole('combobox', { name: /^执行器/ }), 'review')
  await screen.findByRole('heading', { name: '读取执行器修订失败' })
  expect(panel().target).toBeNull()
  fail = false
  await user.click(screen.getByRole('button', { name: '重新加载' }))
  await user.selectOptions(await screen.findByRole('combobox', { name: /^修订/ }), '2')
  expect(panel().target).toEqual({ executorRef: { id: 'review', revision: 2 } })
})

it('没有启用的执行器时显示空态，不读取任何历史', async () => {
  const { calls } = mount('/work-patches/w1/execute', path => path === '/executors'
    ? Response.json([{ id: 'disabled', active: false, revision: 3 }]) : serve(path))
  expect(await screen.findByText('暂无启用的执行器')).toBeVisible()
  expect(panel().target).toBeNull()
  expect(calls).toEqual(['/patches/work/w1', '/executors'])
})
