import { test, expect } from '@playwright/test'
for (const width of [390, 1280])
  test(`列表、筛选和详情深链 ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 820 })
    await page.goto('/sandboxes')
    await expect(page.getByText('演示数据')).toBeVisible()
    await page.getByRole('button', { name: '创建沙箱' }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(page.getByLabel('创建规格（SandboxSpec JSON）')).toBeVisible()
    await page.getByRole('button', { name: '取消' }).click()
    await expect(page.getByRole('dialog')).toBeHidden()
    await expect(page.locator('tbody tr')).toHaveCount(6)
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width)
    await page.getByLabel('实例状态').selectOption('running')
    await expect(page.locator('tbody tr')).toHaveCount(3)
    await page.getByLabel('搜索实例').fill('absent')
    await page.getByRole('button', { name: '清除筛选' }).click()
    await page.getByRole('link', { name: '查看 hello-html' }).click()
    await page.reload()
    await expect(
      page.getByRole('heading', { name: 'hello-html' }),
    ).toBeVisible()
    await expect(page.locator('pre')).toContainText('[status] running')
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width)
    await page.getByRole('link', { name: '实例列表' }).click()
    await expect(page.locator('tbody tr')).toHaveCount(6)
  })
test('Gateway 失败时显示错误，重试后识别空列表', async ({ page }) => {
  await page.route('**/console-config.json', (r) =>
    r.fulfill({ json: { mode: 'gateway' } }),
  )
  let first = true
  await page.route('**/api/v1/sandboxes', (r) => {
    const status = first ? 503 : 200
    first = false
    return r.fulfill({ status, json: { sandboxes: [] } })
  })
  await page.goto('/sandboxes')
  await expect(page.getByRole('status')).toContainText('Gateway 暂不可用')
  await page.getByRole('button', { name: '重试' }).click()
  await expect(page.getByRole('status')).toHaveText('暂无沙箱实例')
})
