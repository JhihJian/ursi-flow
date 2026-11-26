import { test, expect, openNavigation, expectNoOverflow } from './fixtures'

test('深链保留、401 后重新登录、刷新和退出', async ({ page }) => {
  let count = 0
  await page.route('**/api/**', async route => {
    count++
    const path = new URL(route.request().url()).pathname
    expect(path).toBe('/api/v2/work-items')
    if (route.request().headers().authorization !== 'Bearer test-canary') return route.fulfill({ status: 401, json: { error: { code: 'unauthorized' } } })
    return route.fulfill({ json: [{ id: 'w1', title: '本周反馈', category: 'continuous', status: 'active', description: '整理结论' }] })
  })
  await page.goto('/work-items'); await expect(page.getByLabel('访问令牌')).toBeVisible(); expect(count).toBe(0)
  await page.getByLabel('访问令牌').fill('invalid'); await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('令牌无效或已过期，请重新输入。'); await expect(page.getByLabel('访问令牌')).toHaveValue(''); await page.getByLabel('访问令牌').fill('test-canary')
  await page.getByRole('button', { name: '登录', exact: true }).click(); await expect(page.getByText('本周反馈')).toBeVisible()
  await page.reload(); await expect(page.getByText('本周反馈')).toBeVisible(); await expect(page).toHaveURL(/\/work-items$/)
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('test-canary'); await expectNoOverflow(page)
  await openNavigation(page); await page.getByRole('button', { name: '退出登录' }).click(); await expect(page.getByLabel('访问令牌')).toBeVisible()
  expect(await page.evaluate(() => JSON.stringify(sessionStorage))).not.toContain('test-canary')
})

test('导航可跳过，亮暗和主色偏好独立保持', async ({ page }) => {
  await page.goto('/not-a-page'); await expect(page.getByRole('heading', { name: '页面未找到' })).toBeVisible()
  await page.keyboard.press('Tab'); await expect(page.getByRole('link', { name: '跳到主要内容' })).toBeFocused()
  await page.keyboard.press('Enter'); await expect(page.locator('#main-content')).toBeFocused()
  await openNavigation(page); await page.getByRole('button', { name: '切换到暗色主题' }).click(); await page.getByRole('button', { name: '切换到黑白主题' }).click()
  await page.reload(); await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark'); await expect(page.locator('html')).toHaveAttribute('data-palette', 'mono')
  await page.getByRole('link', { name: '返回工作清单' }).click(); await expect(page).toHaveURL(/\/work-items$/)
})
