import { test, expect } from './fixtures'

test('从工作包选 Flow 和已发布修订，通过同源 Workbench 接口启动', async ({ page, baseURL }) => {
  const ref = { id: 'reviewer', revision: 7 }
  const job = { id: 'run-pinned', flow: 'audit', revision: 'f1', status: 'succeeded', executorRef: ref }
  const starts: unknown[] = []
  await page.addInitScript(() => sessionStorage.setItem('ursi-flow:bearer', 'wb-only'))
  await page.route('**/api/**', async route => {
    const req = route.request()
    const url = new URL(req.url())
    expect(url.origin).toBe(baseURL)
    expect(req.headers().authorization).toBe('Bearer wb-only')
    const reads: Record<string, unknown> = {
      '/api/v1/flows': ['audit'], '/api/v2/patches/work/w1': { id: 'w1', name: '审阅', directoryId: 'd1' },
      '/api/v2/executors': [{ id: ref.id, revision: 8, active: true }, { id: 'off', revision: 1, active: false }],
      '/api/v2/executors/reviewer/revisions': [7, 8].map(revision => ({ id: ref.id, revision, agent: { configPackageId: 'policy' } })),
      '/api/v1/runs/run-pinned': job, '/api/v1/runs/run-pinned/history': { job, nodeRuns: [] },
    }
    if (req.method() === 'GET' && url.pathname in reads) return route.fulfill({ json: reads[url.pathname] })
    if (req.method() === 'POST' && url.pathname === '/api/v1/flows/audit/runs') {
      starts.push(req.postDataJSON())
      return route.fulfill({ json: job })
    }
    throw new Error(`非预期请求：${req.method()} ${url.pathname}`)
  })
  await page.goto('/work-patches/w1/execute')
  await page.getByLabel('执行方式').selectOption('flow')
  await page.getByRole('combobox', { name: 'Flow 包', exact: true }).selectOption('audit')
  const start = page.getByRole('button', { name: '启动 Run' })
  await expect(start).toBeDisabled()
  const executor = page.getByRole('combobox', { name: '执行器', exact: true })
  const revision = page.getByRole('combobox', { name: '修订', exact: true })
  await executor.selectOption(ref.id)
  await revision.selectOption('7')
  await executor.selectOption('')
  await expect(start).toBeDisabled()
  await executor.selectOption(ref.id)
  await revision.selectOption('7')
  await page.getByLabel('变量（JSON 对象）').fill('{"sample":"w1"}')
  await start.click()
  await expect(page).toHaveURL(/\/runs\/run-pinned$/)
  expect(starts).toEqual([{ workspace: 'default', variables: { sample: 'w1' }, executorRef: ref }])
})
