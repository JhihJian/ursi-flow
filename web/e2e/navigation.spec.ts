import { expect, test } from '@playwright/test'

const entries = [
  ['/workflows', '工作流'], ['/roles', '角色管理'], ['/runs', '运行记录'],
  ['/artifacts', '产物管理'], ['/sandboxes', '沙箱管理'], ['/connections', '模型连接'],
]

test('六域导航、直达刷新和未知地址', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await expect(page).toHaveURL(/\/workflows$/)
  for (const [path, title] of entries) {
    await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: title, exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`${path}$`))
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(title)
    await expect(page).toHaveTitle(`${title} · ursi-flow`)
    await page.reload()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(title)
    await expect(page.getByText('功能准备中', { exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  }
  await page.goto('/not-a-page')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('页面未找到')
  await page.getByRole('link', { name: '返回工作流', exact: true }).click()
  await expect(page).toHaveURL(/\/workflows$/)
  expect(errors).toEqual([])
})

test('键盘可跳过导航进入内容', async ({ page }) => {
  await page.goto('/roles')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('角色管理')
  await page.keyboard.press('Tab')
  await expect(page.getByRole('link', { name: '跳到主要内容' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.locator('#main-content')).toBeFocused()
})

test('懒加载失败有可恢复提示', async ({ page }) => {
  await page.goto('/workflows')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('工作流')
  await page.route('**/assets/RolesView-*.js', (route) => route.abort())
  await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '角色管理', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('页面加载失败')
  await page.unroute('**/assets/RolesView-*.js')
  await page.getByRole('button', { name: '重新打开页面' }).click()
  await expect(page).toHaveURL(/\/roles$/)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('角色管理')
  await expect(page.getByRole('alert')).toHaveCount(0)
})
