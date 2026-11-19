import { expect, test } from '@playwright/test'

test('纯静态子目录：主题、列表、深链刷新与只读演示', async ({ page }) => {
  const base = 'http://127.0.0.1:14484/dist/'
  const paths = []
  page.on('request', (request) => paths.push(request.url()))
  await page.addInitScript(() => {
    localStorage.setItem('ursi-flow:theme', 'dark')
    localStorage.setItem('ursi-flow:palette', 'mono')
  })
  await page.goto(base)
  await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(9, 9, 9)')
  await expect(page.getByText('演示数据')).toBeVisible()
  await page.getByRole('link', { name: /release-check/ }).click()
  await expect(page).toHaveURL(/\/dist\/#\/flows\/release-check\/edit$/)
  await page.reload()
  // 演示包默认打开图形视图，FLOW.md 只有图形与文档两个视图。
  await expect(page.locator('.cnode')).toHaveCount(2)
  await expect(page.getByRole('tab', { name: '源码' })).toHaveCount(0)
  await page.getByRole('tab', { name: '文档' }).click()
  await expect(page.locator('.md-meta')).toContainText('发布检查')
  await page.getByRole('button', { name: 'references/checklist.md' }).click()
  await expect(page.getByLabel('Markdown 源码')).toContainText('发布检查清单')
  await page.getByRole('link', { name: '运行记录' }).click()
  await page.getByRole('link', { name: 'verify-003', exact: true }).click()
  await expect(page.locator('[data-status="failed"]').first()).toBeVisible()
  await page.getByRole('button', { name: '执行证据' }).click()
  await expect(page.locator('pre.text-destructive')).toContainText('版本号与 CHANGELOG')
  await page.reload()
  await expect(page.getByRole('heading', { name: 'verify-003' })).toBeVisible()
  expect(paths.every((url) => url.startsWith(base))).toBe(true)
  expect(paths.some((url) => url.includes('/api/'))).toBe(false)
})

test('窄屏不产生横向滚动', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 820 })
  await page.goto('http://127.0.0.1:14484/dist/')
  for (const path of ['#/flows', '#/flows/release-check/edit', '#/runs', '#/runs/review-001']) {
    await page.goto('http://127.0.0.1:14484/dist/' + path)
    await expect(page.locator('main').first()).toBeVisible()
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390)
  }
})
