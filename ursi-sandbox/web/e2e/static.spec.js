import { test, expect } from '@playwright/test'

test('纯静态子目录：主题、列表、详情和刷新', async ({ page }) => {
  const base = 'http://127.0.0.1:14482/dist/'
  const paths = []
  page.on('request', (r) => paths.push(r.url()))
  await page.addInitScript(() => {
    localStorage.setItem('ursi-flow:theme', 'dark')
    localStorage.setItem('ursi-flow:palette', 'mono')
  })
  await page.goto(base)
  await expect(page.locator('html')).toHaveCSS(
    'background-color',
    'rgb(9, 9, 9)',
  )
  await page.getByRole('link', { name: '查看 hello-html' }).click()
  await expect(page).toHaveURL(/\/dist\/#\/sandboxes\/[a-f0-9]{32}$/)
  await page.reload()
  await expect(page.locator('pre')).toContainText('[status] running')
  await page.getByRole('link', { name: '实例列表' }).click()
  await expect(page.locator('tbody tr')).toHaveCount(6)
  expect(paths.every((url) => url.startsWith(base))).toBe(true)
})
