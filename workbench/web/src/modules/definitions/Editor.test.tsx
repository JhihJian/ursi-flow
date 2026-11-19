import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { setToken } from '@/shared/http/session'
import { definitionRoutes } from './routes'
import type { Executor, Package } from './catalog'
import { createFakeCatalog } from './fake-catalog'

function start(fake: ReturnType<typeof createFakeCatalog>, path: string) {
  setToken('demo')
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit = {}) => fake.handle(String(url).replace('/api/v2', ''), options)))
  const router = createMemoryRouter(definitionRoutes, { initialEntries: [path] })
  render(<RouterProvider router={router} />)
  return router
}
afterEach(() => { cleanup(); sessionStorage.clear() })

/** 用页面表单依次发布提示词 r1、引用它的执行器 r1 和派工模板 r1。 */
async function publishChain(fake: ReturnType<typeof createFakeCatalog>) {
  const router = start(fake, '/resources/new')

  await userEvent.type(await screen.findByLabelText('资源 ID', { exact: true }), 'guide')
  await userEvent.selectOptions(screen.getByLabelText('资源类型'), 'prompt')
  await userEvent.type(screen.getByLabelText('资源内容'), '按材料逐项核查')
  await userEvent.click(screen.getByRole('button', { name: '发布资源' }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/resources/guide/revisions/1'))

  await router.navigate('/executors/new')
  await userEvent.type(await screen.findByLabelText('执行器 ID', { exact: true }), 'assistant')
  await userEvent.selectOptions(screen.getByLabelText('执行环境'), 'sandbox')
  await userEvent.click(screen.getByRole('button', { name: '添加执行器资源' }))
  await userEvent.selectOptions(screen.getByLabelText('资源 ID', { exact: true }), 'guide')
  await userEvent.selectOptions(await screen.findByLabelText('资源版本', { exact: true }), '1')
  await userEvent.click(screen.getByRole('button', { name: '添加输入字段' }))
  await userEvent.type(screen.getByLabelText('输入字段名'), 'ticket')
  await userEvent.click(screen.getByRole('button', { name: '发布执行器' }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/executors/assistant/revisions/1'))

  await router.navigate('/templates/new')
  await userEvent.type(await screen.findByLabelText('派工模板 ID', { exact: true }), 'triage')
  await userEvent.type(screen.getByLabelText('办理说明'), '按材料逐项核查')
  await userEvent.type(screen.getByLabelText('验收标准'), '结论有证据')
  await userEvent.type(screen.getByLabelText('必交文件（每行一个文件名）'), '核查报告.txt\n\n证据清单.txt')
  await userEvent.click(screen.getByRole('button', { name: '添加输入字段' }))
  await userEvent.type(screen.getByLabelText('输入字段名'), 'ticket')
  await userEvent.type(screen.getByLabelText('动作名称'), 'inspect')
  await userEvent.selectOptions(screen.getByLabelText('执行器 ID', { exact: true }), 'assistant')
  await userEvent.selectOptions(await screen.findByLabelText('执行器版本', { exact: true }), '1')
  await userEvent.click(screen.getByRole('button', { name: '发布派工模板' }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/templates/triage/revisions/1'))
  return router
}

it('只用表单发布提示词 r1、引用它的 Agent r1 与包 r1，详情追到精确修订并从旧版本派工', async () => {
  const fake = createFakeCatalog()
  const router = await publishChain(fake)

  expect(await screen.findByText('正在阅读 v1 · 最新 v1 · 对象已启用')).toBeVisible()
  expect(screen.getByRole('link', { name: '发起工作' })).toHaveAttribute('href', '/items/new?package=triage&revision=1')
  expect(screen.getByRole('link', { name: 'assistant v1' })).toHaveAttribute('href', '/executors/assistant/revisions/1')
  expect(screen.getAllByRole('link', { name: 'guide v1' })[0]).toHaveAttribute('href', '/resources/guide/revisions/1')
  expect(screen.getByRole('heading', { name: 'inspect → assistant v1 → guide v1' })).toBeVisible()
  expect(screen.getByText('按材料逐项核查')).toBeVisible()
  expect(screen.getByText('结论有证据')).toBeVisible()
  expect(screen.getByText('核查报告.txt')).toBeVisible()
  expect(screen.getByText('发布快照只保留合并后的执行器与资源，动作级输入输出声明没有写入快照，编辑历史版本时需要维护人重新核对。')).toBeVisible()

  const executor = fake.latest<Executor>('executors', 'assistant')
  expect(executor).toMatchObject({ revision: 1, kind: 'agent', environment: 'sandbox', resources: [{ id: 'guide', revision: 1 }], inputs: { ticket: 'string' } })
  const pkg = fake.latest<Package>('packages', 'triage')
  expect(pkg.actions.inspect.executor).toEqual({ id: 'assistant', revision: 1, kind: 'agent', environment: 'sandbox' })
  expect(pkg.deliverables).toEqual(['核查报告.txt', '证据清单.txt'])
  expect(pkg.actions.inspect.resources).toEqual([{ id: 'guide', revision: 1, kind: 'prompt', content: '按材料逐项核查' }])
  expect(pkg.inputs).toEqual({ ticket: 'string' })

  // 发布包新版后，从旧版本点击派工仍携带 r1。
  await userEvent.click(screen.getByRole('link', { name: '编辑并发布新版' }))
  const sop = await screen.findByLabelText('办理说明')
  await userEvent.clear(sop)
  await userEvent.type(sop, '新版 SOP')
  await userEvent.click(screen.getByLabelText('我已核对动作资源和输入输出声明'))
  await userEvent.click(screen.getByRole('button', { name: '发布新版' }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/templates/triage/revisions/2'))

  await router.navigate('/templates/triage/revisions/1')
  await waitFor(() => expect(screen.getByRole('link', { name: '发起工作' })).toHaveAttribute('href', '/items/new?package=triage&revision=1'))
  expect(screen.getByText('按材料逐项核查')).toBeVisible()
  expect(screen.getByText('这是冻结的历史版本，只读；发布新版会创建新的修订号。')).toBeVisible()

  // 编辑历史包不会删除可追溯的资源依赖：新版快照仍合并执行器固定的 guide v1。
  expect(fake.latest<Package>('packages', 'triage')).toMatchObject({ revision: 2, sop: '新版 SOP' })
  expect(fake.latest<Package>('packages', 'triage').actions.inspect.resources).toEqual([{ id: 'guide', revision: 1, kind: 'prompt', content: '按材料逐项核查' }])
})

it('编辑历史包须先核对不可还原部分，停用提示说明对新派工的影响且历史仍可读', async () => {
  const fake = createFakeCatalog()
  fake.seed('resources', { id: 'guide', kind: 'prompt', content: '旧提示词' })
  fake.seed('executors', { id: 'assistant', kind: 'agent', environment: 'local', resources: [{ id: 'guide', revision: 1 }] })
  fake.seed('packages', { id: 'triage', sop: '旧 SOP', acceptance: '旧标准', inputs: { ticket: 'string' }, resources: [{ id: 'guide', revision: 1 }],
    actions: { inspect: { executor: { id: 'assistant', revision: 1 }, inputs: { ticket: 'string' } } } })
  fake.seed('resources', { id: 'guide', kind: 'prompt', content: '新提示词' })
  const router = start(fake, '/templates/triage/revisions/1/edit')

  const publish = await screen.findByRole('button', { name: '发布新版' })
  expect(publish).toBeDisabled()
  expect(screen.getByText(/旧快照不含本动作原来的输入输出声明/)).toBeVisible()
  expect(screen.getByText(/无法识别同一版本是否也由动作重复引用/)).toBeVisible()
  // 快照里包的 guide v1 与执行器固定的 guide v1 都转为继承，草稿不重复声明也不删除依赖。
  const revisions = screen.getAllByLabelText('资源版本', { exact: true })
  expect(revisions).toHaveLength(1)
  await waitFor(() => expect(revisions[0]).toHaveValue('1'))
  expect(screen.getAllByLabelText('资源 ID', { exact: true })).toHaveLength(1)
  expect(screen.getByLabelText('办理说明')).toHaveValue('旧 SOP')
  expect(screen.getByLabelText('输入字段名')).toHaveValue('ticket')
  // 快照不含动作级声明，草稿不把它悄悄改成包级声明，而是要求勾选确认后才发布。
  expect(screen.getByLabelText('单独声明动作输入（覆盖派工模板）')).not.toBeChecked()
  expect(screen.getByLabelText('单独声明动作输出（覆盖派工模板）')).not.toBeChecked()

  await userEvent.click(screen.getByLabelText('我已核对动作资源和输入输出声明'))
  expect(publish).not.toBeDisabled()

  // 提示词已有 v2，但编辑历史包仍按 r1 的固定依赖还原，不用最新版替代。
  expect(fake.latest('executors', 'assistant')).toMatchObject({ resources: [{ id: 'guide', revision: 1 }] })

  await userEvent.click(publish)
  await waitFor(() => expect(router.state.location.pathname).toBe('/templates/triage/revisions/2'))
  // 包级输入原样保留，动作级声明无法从快照还原，发布时不会凭空改写，只在核对后才允许发布。
  expect(fake.posts('packages')[0]).toMatchObject({ resources: [{ id: 'guide', revision: 1 }], inputs: { ticket: 'string' },
    actions: { inspect: { executor: { id: 'assistant', revision: 1 } } } })

  // 更新提示词后，旧修订仍按冻结正文读取。
  await router.navigate('/resources/guide/revisions/1')
  await waitFor(() => expect(screen.getByText('旧提示词')).toBeVisible())
  await router.navigate('/resources/guide')
  await waitFor(() => expect(screen.getByText('新提示词')).toBeVisible())

  await router.navigate('/templates/triage/revisions/1')
  await waitFor(() => expect(screen.getByText('旧 SOP')).toBeVisible())

  await userEvent.click(screen.getByRole('button', { name: '停用派工模板' }))
  const dialog = within(await screen.findByRole('dialog'))
  expect(dialog.getByText(/新派工和新引用会失败/)).toBeVisible()
  expect(dialog.getByText(/已有单据及其派工快照不受影响/)).toBeVisible()
  await userEvent.click(dialog.getByRole('button', { name: '确认停用' }))
  expect(await screen.findByText('正在阅读 v1 · 最新 v2 · 对象已停用')).toBeVisible()
  expect(screen.queryByRole('link', { name: '发起工作' })).toBeNull()
  expect(screen.getByText('旧 SOP')).toBeVisible()
})

it('缺少可用执行器时先写包，去补建依赖后回来继续原草稿，校验失败保留输入', async () => {
  const fake = createFakeCatalog()
  const router = start(fake, '/templates/new')

  await userEvent.type(await screen.findByLabelText('派工模板 ID', { exact: true }), 'triage')
  await userEvent.type(screen.getByLabelText('办理说明'), '先核查再结论')
  await userEvent.type(screen.getByLabelText('验收标准'), '结论有证据')
  await userEvent.type(screen.getByLabelText('动作名称'), 'inspect')
  expect(screen.getByText(/还没有可用执行器/)).toBeVisible()

  await userEvent.click(screen.getByRole('link', { name: '补建执行器' }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/executors/new'))
  await userEvent.type(await screen.findByLabelText('执行器 ID', { exact: true }), 'assistant')
  await userEvent.click(screen.getByRole('button', { name: '发布执行器' }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/executors/assistant/revisions/1'))

  await router.navigate('/templates/new')
  expect(await screen.findByText(/已恢复上次在本机保存的未发布草稿/)).toBeVisible()
  expect(screen.getByLabelText('派工模板 ID', { exact: true })).toHaveValue('triage')
  expect(screen.getByLabelText('办理说明')).toHaveValue('先核查再结论')
  expect(screen.getByLabelText('验收标准')).toHaveValue('结论有证据')
  expect(screen.getByLabelText('动作名称')).toHaveValue('inspect')

  await userEvent.selectOptions(screen.getByLabelText('执行器 ID', { exact: true }), 'assistant')
  await userEvent.selectOptions(await screen.findByLabelText('执行器版本', { exact: true }), '1')
  // 发布失败要显示服务错误并保留已填内容。
  fake.failNext('版本冲突，请重试')
  await userEvent.click(screen.getByRole('button', { name: '发布派工模板' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('版本冲突，请重试')
  expect(screen.getByLabelText('办理说明')).toHaveValue('先核查再结论')
  expect(screen.getByLabelText('动作名称')).toHaveValue('inspect')
  expect(screen.getByText(/已恢复上次在本机保存的未发布草稿/)).toBeVisible()

  await userEvent.click(screen.getByRole('button', { name: '发布派工模板' }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/templates/triage/revisions/1'))
  // 发布成功后清掉本机草稿，再进来不会出现已发布内容的残留。
  expect(sessionStorage.getItem(`ursi-flow.definitions.draft:packages:new:draft`)).toBeNull()
})

it('本地、预配沙箱与固定修订 Flow 的配置边界准确，MCP 只登记命名引用且不承诺注入', async () => {
  const fake = createFakeCatalog()
  const router = start(fake, '/executors/new')

  await userEvent.type(await screen.findByLabelText('执行器 ID', { exact: true }), 'assistant')
  expect(screen.getByText(/在服务端所在机器上用服务端配置的 Agent 程序运行/)).toBeVisible()
  await userEvent.click(screen.getByRole('button', { name: '发布执行器' }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/executors/assistant/revisions/1'))
  expect(fake.posts('executors')[0]).toEqual({ id: 'assistant', kind: 'agent', environment: 'local', resources: [] })

  await router.navigate('/executors/new')
  await userEvent.type(await screen.findByLabelText('执行器 ID', { exact: true }), 'boxed')
  await userEvent.selectOptions(screen.getByLabelText('执行环境'), 'sandbox')
  expect(screen.getByText(/使用管理员预配的 ACP 沙箱/)).toBeVisible()
  await userEvent.click(screen.getByRole('button', { name: '发布执行器' }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/executors/boxed/revisions/1'))
  expect(fake.posts('executors')[1]).toEqual({ id: 'boxed', kind: 'agent', environment: 'sandbox', resources: [] })

  await router.navigate('/executors/new')
  await userEvent.selectOptions(await screen.findByLabelText('执行器类型'), 'flow')
  expect(screen.queryByLabelText('执行环境')).toBeNull()
  expect(screen.getByText(/当前不支持注入资源，也不设置执行环境/)).toBeVisible()
  await userEvent.type(screen.getByLabelText('执行器 ID', { exact: true }), 'check')
  await userEvent.type(screen.getByLabelText('Flow ID'), 'review-flow')
  await userEvent.type(screen.getByLabelText('Flow 目录修订'), 'sha-a')
  await userEvent.click(screen.getByRole('button', { name: '发布执行器' }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/executors/check/revisions/1'))
  expect(fake.posts('executors')[2]).toEqual({ id: 'check', kind: 'flow', flowId: 'review-flow', flowRevision: 'sha-a' })
  expect(await screen.findByRole('link', { name: 'review-flow' })).toHaveAttribute('href', '/flows/review-flow/edit')

  await router.navigate('/resources/new')
  await userEvent.selectOptions(await screen.findByLabelText('资源类型'), 'mcp')
  expect(screen.getByText(/本页不提供注入设置/)).toBeVisible()
  await userEvent.type(screen.getByLabelText('资源 ID', { exact: true }), 'tools')
  await userEvent.type(screen.getByLabelText('服务引用'), 'tools')
  await userEvent.type(screen.getByLabelText('凭据引用（可选）'), 'tools-auth')
  await userEvent.click(screen.getByRole('button', { name: '发布资源' }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/resources/tools/revisions/1'))
  expect(fake.posts('resources')[0]).toEqual({ id: 'tools', kind: 'mcp', content: { serverRef: 'tools', credentialRef: 'tools-auth' } })
  expect(await screen.findByText(/当前执行后端不支持注入 MCP，所以它不能作为执行依赖/)).toBeVisible()
})
