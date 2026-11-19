import { test, expect } from '@playwright/test'
for (const width of [390, 1280])
  test(`列表、筛选和详情深链 ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 820 })
    await page.goto('/sandboxes')
    await expect(page.getByText('演示数据')).toBeVisible()
    await page.getByRole('button', { name: '创建沙箱' }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(page.getByLabel('镜像')).toBeVisible()
    await page.getByRole('tab', { name: 'JSON 编辑' }).click()
    await expect(page.getByLabel('SandboxSpec JSON')).toBeVisible()
    await page.getByRole('button', { name: '取消' }).click()
    await expect(page.getByRole('dialog')).toBeHidden()
    await expect(page.locator('tbody tr')).toHaveCount(6)
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width)
    await page.getByRole('button', { name: /运行中/ }).click()
    await expect(page.locator('tbody tr')).toHaveCount(3)
    await page.getByRole('button', { name: /全部实例/ }).click()
    await expect(page.locator('tbody tr')).toHaveCount(6)
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
test('快速创建会把表单转换为 SandboxSpec JSON', async ({ page }) => {
  await page.route('**/console-config.json', (r) =>
    r.fulfill({ json: { mode: 'gateway', manage: true } }),
  )
  await page.route('**/api/v1/sandboxes', async (r) => {
    if (r.request().method() === 'POST') {
      expect(r.request().postDataJSON()).toEqual({
        image: 'node:22',
        command: ['npm', 'start'],
        labels: { name: 'quick-web' },
        memory_mb: 512,
        cpus: 2,
      })
      return r.fulfill({
        status: 202,
        json: {
          id: 'a'.repeat(32),
          spec: {
            image: 'node:22',
            command: ['npm', 'start'],
            labels: { name: 'quick-web' },
            memory_mb: 512,
            cpus: 2,
          },
          resource: { generation: 1, data_generation: 1 },
          status: 'preparing',
          operation: { kind: 'create' },
          retired: [],
          revision: 1,
          endpoints: [],
          error: null,
        },
      })
    }
    return r.fulfill({ json: { sandboxes: [] } })
  })
  await page.goto('/sandboxes')
  await page.getByRole('button', { name: '创建沙箱' }).click()
  await page.getByLabel('镜像').fill('node:22')
  await page.getByLabel('名称（可选）').fill('quick-web')
  await page.getByLabel('命令参数（每行一个参数，可选）').fill('npm\nstart')
  await page.getByLabel('内存（MiB）').fill('512')
  await page.getByLabel('CPU').fill('2')
  await page.getByRole('button', { name: '提交创建' }).click()
  await expect(page).toHaveURL(/#\/sandboxes\/[a-f0-9]{32}$/)
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
