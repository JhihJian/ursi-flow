import { expect, test } from '@playwright/test'

test('独立登录后编辑、发布并查看真实路由，只访问同源 v2 管理 API', async ({ page, baseURL }) => {
  const calls: string[] = []
  const resource = { id: 'guide', kind: 'prompt', content: '复核结果', revision: 1 }
  await page.addInitScript(() => sessionStorage.setItem('ursi-flow:bearer', 'workbench-only'))
  await page.route('**/api/**', async route => {
    const req = route.request()
    const url = new URL(req.url())
    const key = `${req.method()} ${url.pathname}`
    calls.push(key)
    expect(url.origin).toBe(baseURL)
    expect(req.headers().authorization).toBe('Bearer platform-token')
    if (key === 'POST /api/v2/resources') {
      expect(req.postDataJSON()).toMatchObject({ id: resource.id, kind: resource.kind, content: resource.content })
      return route.fulfill({ json: resource })
    }
    if (key === 'GET /api/v2/resources/guide') return route.fulfill({ json: { ...resource, active: true } })
    if (key === 'GET /api/v2/resources/guide/revisions/1') return route.fulfill({ json: resource })
    if (['GET /api/v2/patches/config', 'GET /api/v2/agent-backends'].includes(key)) return route.fulfill({ json: [] })
    throw new Error(`意外请求：${key}`)
  })
  await page.goto('/executors/new?mode=agent')
  await expect(page.getByRole('heading', { name: '登录执行器管理平台' })).toBeVisible()
  expect(calls).toEqual([])
  await page.getByLabel('访问令牌').fill('platform-token')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByText('暂无配置包。')).toBeVisible()
  await expect(page.getByLabel('样例工作包（可选）')).toHaveCount(0)
  await page.getByRole('link', { name: '前往创建配置包' }).click()
  await expect(page.getByRole('heading', { name: '暂无配置包' })).toBeVisible()
  await page.getByRole('link', { name: 'Agent 后端' }).click()
  await expect(page.getByRole('heading', { name: '暂无 Agent 后端' })).toBeVisible()
  await page.goto('/resources/new')
  await page.getByLabel('资源 ID').fill(resource.id)
  await page.getByLabel('资源类型').selectOption('prompt')
  await page.getByLabel('资源内容').fill(resource.content)
  await page.getByRole('button', { name: '发布资源' }).click()
  await expect(page).toHaveURL(/\/resources\/guide\/revisions\/1$/)
  await expect(page.getByText(resource.content)).toBeVisible()
  await page.getByRole('button', { name: '退出登录' }).click()
  await expect(page.getByLabel('访问令牌')).toBeVisible()
})
