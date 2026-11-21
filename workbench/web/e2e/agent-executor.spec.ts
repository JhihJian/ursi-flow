import { expect, test } from './fixtures'

test('草稿试跑与发布版运行各自打开本次制品，刷新工作包不重发运行', async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('ursi-flow:bearer', 'test'))
  const patch = { id: 'sample', name: '样例包', directoryId: 'inputs' }
  const config = { id: 'policy', name: '核查配置', directoryId: 'policy-files' }
  const definition = { id: 'review', agent: { configPackageId: config.id } }
  const version = { ...definition, revision: 1, active: true }
  let published = false
  const attempts = new Map<string, string>()
  await page.route('**/api/v2/**', async route => {
    const url = new URL(route.request().url())
    const path = url.pathname.slice('/api/v2'.length)
    const method = route.request().method()
    if (path === '/executors' && method === 'POST') {
      expect(route.request().postDataJSON()).toEqual(definition)
      published = true
      return route.fulfill({ json: version })
    }
    if (path.startsWith('/executor-attempts/')) {
      const attemptId = path.split('/').pop()!
      if (method === 'PUT') {
        const target = published ? { executorRef: { id: version.id, revision: 1 } } : { previewDefinition: definition }
        expect(route.request().postDataJSON()).toEqual({ ...target, workPatchId: patch.id, workInstruction: { encoding: 'utf-8', text: published ? '正式核查' : '试跑核查' } })
        expect(attempts.has(attemptId)).toBe(false)
        attempts.set(attemptId, published ? 'formal' : 'preview')
      }
      expect(attempts.has(attemptId)).toBe(true)
      return route.fulfill({ json: { attemptId, status: 'succeeded', artifactDirectoryId: attempts.get(attemptId) } })
    }
    if (method === 'GET') {
      const reads: Record<string, unknown> = {
        '/resources': [], '/patches/config': [config], '/directories/policy-files/tree': [],
        '/patches/work': [patch], '/patches/work/sample': patch,
        '/executors': published ? [version] : [], '/executors/review': version,
        '/executors/review/revisions': [version], '/executors/review/revisions/1': version,
      }
      if (Object.hasOwn(reads, path)) return route.fulfill({ json: reads[path] })
      if (/^\/directories\/(formal|preview)\/tree$/.test(path)) return route.fulfill({ json: [{ kind: 'file', path: '报告.txt' }] })
      if (/^\/directories\/(formal|preview)\/file$/.test(path) && url.searchParams.get('path') === '报告.txt') {
        return route.fulfill({ contentType: 'application/octet-stream', body: path.includes('/preview/') ? '试跑报告' : '正式报告' })
      }
    }
    throw new Error(`非预期请求：${method} ${path}`)
  })

  await page.goto('/executors/new')
  await page.getByRole('link', { name: '基于 Agent 配置' }).click()
  await page.getByLabel('执行器 ID').fill(definition.id)
  await expect(page.getByRole('button', { name: '发布执行器' })).toBeDisabled()
  await page.getByLabel('配置包', { exact: true }).selectOption(config.id)
  await page.getByRole('link', { name: '编辑配置包' }).click()
  await expect(page).toHaveURL(/\/config-patches\/policy$/)
  await expect(page.getByRole('tab', { name: '总览' })).toBeVisible()
  await page.goBack()
  await expect(page.getByLabel('配置包', { exact: true })).toHaveValue(config.id)
  await page.getByLabel('样例工作包（可选）').selectOption(patch.id)
  await page.getByLabel('本次指令').fill('试跑核查')
  await page.getByRole('button', { name: '试跑', exact: true }).click()
  await page.getByRole('button', { name: '报告.txt' }).click()
  await expect(page.getByText('试跑报告')).toBeVisible()
  await page.getByRole('button', { name: '发布执行器' }).click()
  await expect(page).toHaveURL(/\/executors\/review\/revisions\/1$/)

  await page.goto('/work-patches')
  await page.getByRole('link', { name: '运行工作包' }).click()
  await page.getByRole('combobox', { name: /^执行器/ }).selectOption(version.id)
  await page.getByRole('combobox', { name: /^修订/ }).selectOption('1')
  await page.getByLabel('本次指令').fill('正式核查')
  await page.getByRole('button', { name: '启动' }).click()
  await expect(page.getByText('已完成')).toBeVisible()
  await page.reload()
  await page.getByRole('button', { name: '报告.txt' }).click()
  await expect(page.getByText('正式报告')).toBeVisible()
  expect([...attempts.values()]).toEqual(['preview', 'formal'])
})
