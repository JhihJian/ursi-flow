import { test, expect, openNavigation, expectNoOverflow } from './fixtures'

const token = 'entry-canary'
const listApis = ['/api/v2/work-items', '/api/v2/patches/work']

test('工作项深链在原址登录，退出后隐藏数据', async ({ page }) => {
  const seen: string[] = []
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname
    seen.push(path)
    expect(route.request().headers().authorization).toBe(`Bearer ${token}`)
    if (path === '/api/v2/work-items/example') return route.fulfill({ json: {
      id: 'example', revision: 1, title: '本周反馈', category: 'continuous', status: 'active', description: '整理复核结论',
    } })
    expect(['/api/v2/patches/work']).toContain(path)
    return route.fulfill({ json: [] })
  })
  const target = /\/work-items\/example\?from=list#detail$/
  await page.goto('/work-items/example?from=list#detail')
  await expect(page.getByLabel('访问令牌')).toBeVisible()
  expect(seen).toEqual([])
  await page.getByLabel('访问令牌').fill(token)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page).toHaveURL(target)
  await expect(page.getByRole('heading', { name: '本周反馈' })).toBeVisible()
  await expect(page.getByText('整理复核结论')).toBeVisible()
  await expectNoOverflow(page)
  await openNavigation(page)
  await page.getByRole('button', { name: '退出登录' }).click()
  await expect(page.getByLabel('访问令牌')).toBeVisible()
  await expect(page.getByText('整理复核结论')).toHaveCount(0)
  await expect(page).toHaveURL(target)
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(token)
})

test('旧地址显示未找到，可返回工作清单', async ({ page }) => {
  await page.route('**/api/**', route => {
    expect(listApis).toContain(new URL(route.request().url()).pathname)
    return route.fulfill({ json: [] })
  })
  await page.goto('/items')
  await expect(page.getByRole('heading', { name: '页面未找到' })).toBeVisible()
  await page.getByRole('link', { name: '返回工作清单' }).click()
  await expect(page).toHaveURL(/\/work-items$/)
  await page.getByLabel('访问令牌').fill(token)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByText('暂无工作项')).toBeVisible()
  await expectNoOverflow(page)
  await openNavigation(page)
  const nav = page.getByRole('navigation', { name: '主导航' })
  await expect(nav.getByRole('link', { name: 'Flow 包' })).toBeVisible()
  await expect(nav.getByRole('link', { name: '工作包', exact: true })).toHaveAttribute('href', '/work-patches')
  await expect(nav.getByRole('link', { name: '配置包' })).toHaveAttribute('href', '/config-patches')
  await expect(nav.getByRole('link', { name: /派工|外部来源|Echo 工作区|SOP/ })).toHaveCount(0)
})
